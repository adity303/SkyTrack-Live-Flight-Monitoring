import json
import os
import sqlite3
import subprocess
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from math import atan2, cos, radians, sin, sqrt
from pathlib import Path
from urllib.request import urlopen

import requests
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from airport_service import get_airport as get_airport_csv
from flight_api import FlightSearchError, search_flight_number
from reports import (
    build_report,
    flight_statistics_rows,
    route_details_rows,
    tracking_history_rows,
)

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent
CONFIG_PATH = PROJECT_ROOT / "config.json"

load_dotenv(BASE_DIR / ".env")


def load_config() -> dict:
    defaults = {
        "host": "127.0.0.1",
        "port": 8000,
        "frontend_dir": "frontend",
        "database_path": "backend/skytrack_history.db",
        "open_browser": True,
        "opensky_base_url": "https://opensky-network.org/api",
        "poll_interval_ms": 15000,
    }
    if CONFIG_PATH.exists():
        try:
            with CONFIG_PATH.open("r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                defaults.update(data)
        except Exception:
            pass
    return defaults


CONFIG = load_config()

HOST = os.getenv("SKYTRACK_HOST", str(CONFIG.get("host", "127.0.0.1")))
PORT = int(os.getenv("SKYTRACK_PORT", str(CONFIG.get("port", 8000))))
OPEN_BROWSER = str(CONFIG.get("open_browser", True)).lower() not in {"0", "false", "no"}
FRONTEND_DIR = (PROJECT_ROOT / str(CONFIG.get("frontend_dir", "frontend"))).resolve()
DB_PATH = (PROJECT_ROOT / str(CONFIG.get("database_path", "backend/skytrack_history.db"))).resolve()
BASE_URL = str(CONFIG.get("opensky_base_url", "https://opensky-network.org/api")).rstrip("/")
POLL_INTERVAL_MS = int(CONFIG.get("poll_interval_ms", 15000))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

_airport_cache: dict[str, dict | None] = {}


def get_airport(icao: str):
    icao = icao.upper()
    if icao in _airport_cache:
        return _airport_cache[icao]
    airport = get_airport_csv(icao)
    _airport_cache[icao] = airport
    return airport


def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS flight_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                icao24 TEXT NOT NULL,
                callsign TEXT,
                origin_country TEXT,
                longitude REAL,
                latitude REAL,
                altitude REAL,
                on_ground INTEGER,
                velocity REAL,
                heading REAL,
                timestamp TEXT NOT NULL
            )"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_icao24 ON flight_history(icao24)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_timestamp ON flight_history(timestamp)")
        conn.commit()


def save_position(data):
    try:
        with get_db_connection() as conn:
            conn.execute(
                """INSERT INTO flight_history
                    (icao24, callsign, origin_country, longitude, latitude, altitude,
                     on_ground, velocity, heading, timestamp)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    data.get("icao24"),
                    data.get("callsign"),
                    data.get("origin_country"),
                    data.get("longitude"),
                    data.get("latitude"),
                    data.get("altitude"),
                    1 if data.get("on_ground") else 0,
                    data.get("velocity"),
                    data.get("heading"),
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
            conn.commit()
    except Exception:
        # Persistence failures should not break live tracking responses.
        pass


def check_database() -> dict:
    try:
        with get_db_connection() as conn:
            conn.execute("SELECT 1").fetchone()
        return {"ok": True, "path": str(DB_PATH)}
    except Exception as exc:
        return {"ok": False, "path": str(DB_PATH), "error": str(exc)}


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="SkyTrack Flight Tracker", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[f"http://{HOST}:{PORT}", f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount frontend static assets at stable paths
for mount_name in ("css", "js", "assets"):
    mount_dir = FRONTEND_DIR / mount_name
    if mount_name == "assets":
        mount_dir.mkdir(parents=True, exist_ok=True)
    if mount_dir.is_dir():
        app.mount(f"/{mount_name}", StaticFiles(directory=str(mount_dir)), name=mount_name)


@app.get("/", include_in_schema=False)
def home():
    index_path = FRONTEND_DIR / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=500, detail="Frontend index.html not found")
    return FileResponse(str(index_path))


@app.get("/flight.html", include_in_schema=False)
def flight_page():
    path = FRONTEND_DIR / "flight.html"
    if path.exists():
        return FileResponse(str(path))
    raise HTTPException(status_code=404, detail="Not found")


@app.get("/sw.js", include_in_schema=False)
def service_worker():
    return Response(content="", media_type="application/javascript")


@app.get("/js/config.js", include_in_schema=False)
def frontend_config():
    cfg = {
        "apiBase": "",
        "pollIntervalMs": POLL_INTERVAL_MS,
        "appUrl": f"http://{HOST}:{PORT}",
    }
    body = "window.SKYTRACK_CONFIG = " + json.dumps(cfg) + ";"
    return Response(content=body, media_type="application/javascript")


@app.get("/health")
def health():
    db = check_database()
    frontend_ok = (FRONTEND_DIR / "index.html").exists()
    status = "ok" if db.get("ok") and frontend_ok else "degraded"
    code = 200 if status == "ok" else 503
    return JSONResponse(
        status_code=code,
        content={
            "status": status,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "database": db,
            "frontend": {"ok": frontend_ok, "path": str(FRONTEND_DIR)},
            "config": {
                "host": HOST,
                "port": PORT,
                "opensky_base_url": BASE_URL,
            },
        },
    )


@app.get("/flight/{icao24}")
def get_flight(icao24: str, expected_callsign: str | None = Query(None)):
    url = f"{BASE_URL}/states/all"
    try:
        response = requests.get(url, params={"icao24": icao24.lower()}, timeout=15)
        if response.status_code == 403:
            raise HTTPException(
                status_code=502, detail="Flight data provider requires authentication"
            )
        response.raise_for_status()
        data = response.json()
        states = data.get("states") or []
        if not states:
            raise HTTPException(
                status_code=404, detail="Aircraft not currently available"
            )
        state = states[0]
        actual_callsign = (state[1] or "").strip().upper()
        if (
            expected_callsign
            and actual_callsign
            and actual_callsign != expected_callsign.strip().upper()
        ):
            raise HTTPException(
                status_code=409,
                detail="The identified aircraft is broadcasting a different callsign; its position was not shown.",
            )
        result = {
            "icao24": state[0],
            "callsign": state[1],
            "origin_country": state[2],
            "time_position": state[3],
            "last_contact": state[4],
            "longitude": state[5],
            "latitude": state[6],
            "altitude": state[7],
            "on_ground": state[8],
            "velocity": state[9],
            "heading": state[10],
            "vertical_rate": state[11],
            "geo_altitude": state[13],
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        save_position(result)
        return result
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="Flight data provider unavailable")


def _parse_waypoint(point):
    if len(point) < 3:
        return None
    if point[1] is None or point[2] is None:
        return None
    return {
        "timestamp": point[0],
        "latitude": point[1],
        "longitude": point[2],
        "altitude": point[3] if len(point) > 3 else None,
        "heading": point[4] if len(point) > 4 else None,
        "on_ground": point[5] if len(point) > 5 else None,
    }


@app.get("/flight/{icao24}/track")
def get_flight_track(icao24: str, start: int = 0, end: int = 0):
    url = f"{BASE_URL}/tracks/all"
    params: dict[str, str | int] = {"icao24": icao24.lower()}
    if start:
        params["time"] = start
    if end:
        params["end"] = end

    try:
        response = requests.get(url, params=params, timeout=20)
        if response.status_code == 404:
            raise HTTPException(
                status_code=404,
                detail="No historical trajectory available for this aircraft.",
            )
        response.raise_for_status()
        data = response.json()
        raw_path = data.get("path", []) or []
        waypoints = [wp for wp in (_parse_waypoint(p) for p in raw_path) if wp]
        timestamps = [wp["timestamp"] for wp in waypoints if wp.get("timestamp")]
        durations = [
            timestamps[i + 1] - timestamps[i]
            for i in range(len(timestamps) - 1)
            if timestamps[i + 1] is not None and timestamps[i] is not None
        ]
        total_duration = sum(durations) if durations else 0
        return {
            "icao24": data.get("icao24"),
            "callsign": data.get("callsign"),
            "start_time": data.get("startTime"),
            "end_time": data.get("endTime"),
            "total_waypoints": len(waypoints),
            "total_duration_seconds": total_duration,
            "path": waypoints,
        }
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="Trajectory provider unavailable.")


@app.get("/flight/{icao24}/airports")
def get_flight_airports(icao24: str):
    end_time = int(time.time())
    begin_time = end_time - (2 * 24 * 60 * 60)
    url = f"{BASE_URL}/flights/aircraft"
    try:
        response = requests.get(
            url,
            params={"icao24": icao24.lower(), "begin": begin_time, "end": end_time},
            timeout=20,
        )
        if response.status_code == 404:
            return {"message": "No historical flight records found", "flights": []}
        response.raise_for_status()
        flights = response.json()
        return {"icao24": icao24.lower(), "total_flights": len(flights), "flights": flights}
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="Unable to retrieve airport information")


@app.get("/flight-history/{icao24}")
def get_flight_history(icao24: str, limit: int = Query(200, ge=1, le=1000)):
    try:
        with get_db_connection() as conn:
            rows = conn.execute(
                """SELECT icao24, callsign, origin_country, longitude, latitude, altitude,
                          on_ground, velocity, heading, timestamp
                   FROM flight_history
                   WHERE icao24 = ?
                   ORDER BY timestamp DESC
                   LIMIT ?""",
                (icao24.lower(), limit),
            ).fetchall()
    except Exception:
        raise HTTPException(status_code=503, detail="Flight history database unavailable")

    if not rows:
        raise HTTPException(status_code=404, detail="No history found for this aircraft")
    return [
        {
            "icao24": r["icao24"],
            "callsign": r["callsign"],
            "origin_country": r["origin_country"],
            "longitude": r["longitude"],
            "latitude": r["latitude"],
            "altitude": r["altitude"],
            "on_ground": bool(r["on_ground"]),
            "velocity": r["velocity"],
            "heading": r["heading"],
            "timestamp": r["timestamp"],
        }
        for r in rows
    ]


@app.get("/search/{flight_number}")
def search_by_flight_number(flight_number: str):
    try:
        return {"results": search_flight_number(flight_number)}
    except FlightSearchError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@app.get("/airport/{icao}")
def airport_details(icao: str):
    airport = get_airport(icao.upper())
    if not airport:
        raise HTTPException(status_code=404, detail="Airport not found")
    return airport


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    phi1, phi2 = radians(lat1), radians(lat2)
    dphi = radians(lat2 - lat1)
    dlambda = radians(lon2 - lon1)
    a = sin(dphi / 2) ** 2 + cos(phi1) * cos(phi2) * sin(dlambda / 2) ** 2
    return 2 * R * atan2(sqrt(a), sqrt(1 - a))


def estimate_eta(distance_km: float, speed_kts: float | None) -> str | None:
    if not speed_kts or speed_kts <= 0:
        return None
    speed_kmh = speed_kts * 1.852
    hours = distance_km / speed_kmh
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()


@app.get("/flight/{icao24}/route")
def get_flight_route(icao24: str):
    end_time = int(time.time())
    begin_time = end_time - (2 * 24 * 60 * 60)
    url = f"{BASE_URL}/flights/aircraft"
    try:
        response = requests.get(
            url,
            params={"icao24": icao24.lower(), "begin": begin_time, "end": end_time},
            timeout=20,
        )
        if response.status_code == 404:
            raise HTTPException(status_code=404, detail="No flight records found")
        response.raise_for_status()
        flights = response.json()
        if not flights:
            raise HTTPException(status_code=404, detail="No flight records found")

        latest = flights[-1]
        dep_icao = latest.get("estDepartureAirport")
        arr_icao = latest.get("estArrivalAirport")
        departure = get_airport(dep_icao) if dep_icao else None
        arrival = get_airport(arr_icao) if arr_icao else None
        planned_distance = None
        if departure and arrival:
            planned_distance = haversine(
                departure["latitude"],
                departure["longitude"],
                arrival["latitude"],
                arrival["longitude"],
            )

        return {
            "icao24": icao24.lower(),
            "callsign": latest.get("callsign"),
            "departure": {
                "icao": dep_icao,
                "iata": departure.get("iata") if departure else None,
                "name": departure.get("name") if departure else None,
                "latitude": departure.get("latitude") if departure else None,
                "longitude": departure.get("longitude") if departure else None,
                "municipality": departure.get("municipality") if departure else None,
                "country": departure.get("country") if departure else None,
            }
            if dep_icao
            else None,
            "arrival": {
                "icao": arr_icao,
                "iata": arrival.get("iata") if arrival else None,
                "name": arrival.get("name") if arrival else None,
                "latitude": arrival.get("latitude") if arrival else None,
                "longitude": arrival.get("longitude") if arrival else None,
                "municipality": arrival.get("municipality") if arrival else None,
                "country": arrival.get("country") if arrival else None,
            }
            if arr_icao
            else None,
            "planned_distance_km": round(planned_distance, 1) if planned_distance else None,
        }
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="Flight data provider unavailable")


@app.get("/flight/{icao24}/trajectory")
def get_flight_trajectory(icao24: str, start: int = 0, end: int = 0):
    url = f"{BASE_URL}/tracks/all"
    params: dict[str, str | int] = {"icao24": icao24.lower()}
    if start:
        params["time"] = start
    if end:
        params["end"] = end

    try:
        response = requests.get(url, params=params, timeout=20)
        if response.status_code == 404:
            raise HTTPException(status_code=404, detail="No historical trajectory available")
        response.raise_for_status()

        data = response.json()
        raw_path = data.get("path", []) or []
        waypoints = [wp for wp in (_parse_waypoint(p) for p in raw_path) if wp]
        if not waypoints:
            raise HTTPException(status_code=404, detail="No valid waypoints in trajectory")

        actual_distance = 0.0
        for i in range(len(waypoints) - 1):
            wp1, wp2 = waypoints[i], waypoints[i + 1]
            if wp1.get("latitude") and wp1.get("longitude") and wp2.get("latitude") and wp2.get("longitude"):
                actual_distance += haversine(
                    wp1["latitude"], wp1["longitude"], wp2["latitude"], wp2["longitude"]
                )

        route_data = None
        planned_distance = None
        try:
            route_resp = requests.get(
                f"{BASE_URL}/flights/aircraft",
                params={
                    "icao24": icao24.lower(),
                    "begin": int(time.time()) - 2 * 24 * 3600,
                    "end": int(time.time()),
                },
                timeout=10,
            )
            if route_resp.status_code == 200:
                flights = route_resp.json()
                if flights:
                    latest = flights[-1]
                    dep_icao = latest.get("estDepartureAirport")
                    arr_icao = latest.get("estArrivalAirport")
                    dep = get_airport(dep_icao) if dep_icao else None
                    arr = get_airport(arr_icao) if arr_icao else None
                    if dep and arr:
                        planned_distance = haversine(
                            dep["latitude"], dep["longitude"], arr["latitude"], arr["longitude"]
                        )
                        route_data = {
                            "departure": {
                                "icao": dep_icao,
                                "name": dep.get("name"),
                                "latitude": dep.get("latitude"),
                                "longitude": dep.get("longitude"),
                            },
                            "arrival": {
                                "icao": arr_icao,
                                "name": arr.get("name"),
                                "latitude": arr.get("latitude"),
                                "longitude": arr.get("longitude"),
                            },
                        }
        except Exception:
            pass

        current = waypoints[-1]
        current_lat, current_lon = current.get("latitude"), current.get("longitude")
        current_speed = current.get("velocity")
        current_speed_kts = current_speed * 1.94384 if current_speed else None

        remaining_distance = None
        progress_pct = None
        eta = None
        if route_data and planned_distance and current_lat and current_lon:
            arr_lat = route_data["arrival"]["latitude"]
            arr_lon = route_data["arrival"]["longitude"]
            if arr_lat and arr_lon:
                remaining_distance = haversine(current_lat, current_lon, arr_lat, arr_lon)
                if planned_distance > 0:
                    progress_pct = min(100, max(0, (actual_distance / planned_distance) * 100))
                eta = estimate_eta(remaining_distance, current_speed_kts)

        timestamps = [wp["timestamp"] for wp in waypoints if wp.get("timestamp")]
        durations = [
            timestamps[i + 1] - timestamps[i]
            for i in range(len(timestamps) - 1)
            if timestamps[i + 1] is not None and timestamps[i] is not None
        ]
        total_duration = sum(durations) if durations else 0

        return {
            "icao24": data.get("icao24"),
            "callsign": data.get("callsign"),
            "start_time": data.get("startTime"),
            "end_time": data.get("endTime"),
            "total_waypoints": len(waypoints),
            "total_duration_seconds": total_duration,
            "actual_distance_km": round(actual_distance, 1),
            "planned_distance_km": round(planned_distance, 1) if planned_distance else None,
            "progress_percent": round(progress_pct, 1) if progress_pct else None,
            "remaining_distance_km": round(remaining_distance, 1) if remaining_distance else None,
            "estimated_arrival": eta,
            "current_position": {
                "latitude": current_lat,
                "longitude": current_lon,
                "altitude": current.get("altitude"),
                "heading": current.get("heading"),
                "velocity_kts": round(current_speed_kts, 1) if current_speed_kts else None,
                "on_ground": current.get("on_ground"),
                "timestamp": current.get("timestamp"),
            },
            "path": waypoints,
        }
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="Trajectory provider unavailable.")


@app.get("/flight/{icao24}/reports/tracking-history")
def export_tracking_history(
    icao24: str,
    format: str = Query("csv", pattern="^(csv|excel|pdf)$"),
    limit: int = Query(1000, ge=1, le=10000),
):
    try:
        with get_db_connection() as conn:
            rows = conn.execute(
                """SELECT icao24, callsign, origin_country, longitude, latitude, altitude,
                          on_ground, velocity, heading, timestamp
                   FROM flight_history
                   WHERE icao24 = ?
                   ORDER BY timestamp DESC
                   LIMIT ?""",
                (icao24.lower(), limit),
            ).fetchall()
    except Exception:
        raise HTTPException(status_code=503, detail="Flight history database unavailable")

    if not rows:
        raise HTTPException(status_code=404, detail="No tracking history found for this aircraft")

    records = [dict(r) for r in rows]
    headers, data_rows = tracking_history_rows(records)
    path, name, media_type = build_report(
        icao24,
        "tracking-history",
        f"SkyTrack - Tracking History - {icao24.upper()}",
        headers,
        data_rows,
        format,
    )
    return FileResponse(
        path,
        media_type=media_type,
        filename=name,
        background=BackgroundTask(lambda p=path: p.unlink(missing_ok=True)),
    )


@app.get("/flight/{icao24}/reports/route-details")
def export_route_details(
    icao24: str,
    format: str = Query("csv", pattern="^(csv|excel|pdf)$"),
):
    try:
        response = requests.get(
            f"http://{HOST}:{PORT}/flight/{icao24.lower()}/route", timeout=20
        )
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="Route service unavailable")
    if response.status_code == 404:
        raise HTTPException(status_code=404, detail="No route details found for this aircraft")
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail="Unable to retrieve route details")

    route = response.json()
    headers, data_rows = route_details_rows(route)
    path, name, media_type = build_report(
        icao24,
        "route-details",
        f"SkyTrack - Route Details - {icao24.upper()}",
        headers,
        data_rows,
        format,
    )
    return FileResponse(
        path,
        media_type=media_type,
        filename=name,
        background=BackgroundTask(lambda p=path: p.unlink(missing_ok=True)),
    )


@app.get("/flight/{icao24}/reports/flight-statistics")
def export_flight_statistics(
    icao24: str,
    format: str = Query("csv", pattern="^(csv|excel|pdf)$"),
):
    try:
        response = requests.get(
            f"http://{HOST}:{PORT}/flight/{icao24.lower()}/trajectory", timeout=20
        )
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="Trajectory service unavailable")
    if response.status_code == 404:
        raise HTTPException(status_code=404, detail="No flight statistics found for this aircraft")
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail="Unable to retrieve flight statistics")

    trajectory = response.json()
    headers, data_rows = flight_statistics_rows(trajectory)
    path, name, media_type = build_report(
        icao24,
        "flight-statistics",
        f"SkyTrack - Flight Statistics - {icao24.upper()}",
        headers,
        data_rows,
        format,
    )
    return FileResponse(
        path,
        media_type=media_type,
        filename=name,
        background=BackgroundTask(lambda p=path: p.unlink(missing_ok=True)),
    )


def _is_port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    try:
        result = subprocess.run(
            ["netstat", "-ano"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        token = f":{port}"
        for line in result.stdout.splitlines():
            if token in line and "LISTENING" in line:
                return True
    except Exception:
        pass
    return False


def _wait_for_health(url: str, timeout_s: int = 30) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with urlopen(url, timeout=2) as resp:
                if 200 <= resp.status < 500:
                    return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


if __name__ == "__main__":
    app_url = f"http://{HOST}:{PORT}"
    if _is_port_in_use(PORT):
        print(f"[SkyTrack] Port {PORT} is already in use. Stop the existing process or change config.json.")
        raise SystemExit(1)

    if not (FRONTEND_DIR / "index.html").exists():
        print(f"[SkyTrack] Frontend not found at: {FRONTEND_DIR}")
        raise SystemExit(1)

    try:
        init_db()
    except Exception as exc:
        print(f"[SkyTrack] Database initialization failed: {exc}")
        raise SystemExit(1)

    if OPEN_BROWSER:
        def _open_when_ready():
            if _wait_for_health(f"{app_url}/health", timeout_s=30):
                try:
                    import webbrowser
                    webbrowser.open(app_url)
                except Exception as exc:
                    print(f"[SkyTrack] Failed to open browser: {exc}")
            else:
                print("[SkyTrack] Server did not become healthy in time; browser not opened.")

        threading.Thread(target=_open_when_ready, daemon=True).start()

    print(f"[SkyTrack] Starting server at {app_url}")
    uvicorn.run(app, host=HOST, port=PORT, reload=False, log_level="info")
