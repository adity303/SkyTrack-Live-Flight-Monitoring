import os
import re

import requests


AVIATIONSTACK_URL = "https://api.aviationstack.com/v1/flights"


class FlightSearchError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code


def _normalize_flight_number(flight_number: str) -> str:
    normalized = re.sub(r"\s+", "", flight_number).upper()
    if not re.fullmatch(r"[A-Z0-9]{2,3}\d{1,4}[A-Z]?", normalized):
        raise FlightSearchError(
            422, "Enter a valid airline flight number, such as AI101."
        )
    return normalized


def search_flight_number(flight_number: str) -> list[dict]:
    normalized = _normalize_flight_number(flight_number)
    access_key = os.environ.get("AVIATIONSTACK_API_KEY")
    if not access_key:
        raise FlightSearchError(
            503,
            "Flight-number search is not configured. Set AVIATIONSTACK_API_KEY.",
        )

    try:
        response = requests.get(
            AVIATIONSTACK_URL,
            params={"access_key": access_key, "flight_iata": normalized, "limit": 20},
            timeout=15,
        )
        response.raise_for_status()
        payload = response.json()
    except requests.RequestException as exc:
        raise FlightSearchError(502, "Flight search provider is unavailable.") from exc
    except ValueError as exc:
        raise FlightSearchError(502, "Flight search provider returned invalid data.") from exc

    if not isinstance(payload, dict):
        raise FlightSearchError(502, "Flight search provider returned invalid data.")
    if payload.get("error"):
        error_code = payload["error"].get("code", "")
        if error_code == "invalid_access_key":
            raise FlightSearchError(
                503,
                "Invalid Aviationstack API key. Get a free key at https://aviationstack.com/signup/free and set it in backend/.env as AVIATIONSTACK_API_KEY=your_key",
            )
        raise FlightSearchError(
            502, "Flight search provider rejected the request; check its API key and plan."
        )

    flights = payload.get("data")
    if not isinstance(flights, list):
        raise FlightSearchError(502, "Flight search provider returned invalid data.")

    results = []
    seen = set()
    for item in flights:
        if not isinstance(item, dict):
            continue
        flight = item.get("flight") or {}
        if not isinstance(flight, dict):
            continue

        raw_flight_iata = flight.get("iata")
        flight_iata = (
            raw_flight_iata.replace(" ", "").upper()
            if isinstance(raw_flight_iata, str)
            else ""
        )
        if flight_iata != normalized:
            continue

        aircraft = item.get("aircraft") or {}
        if not isinstance(aircraft, dict):
            aircraft = {}
        raw_icao24 = aircraft.get("icao24")
        icao24 = raw_icao24.lower() if isinstance(raw_icao24, str) else ""
        if not re.fullmatch(r"[a-f0-9]{6}", icao24):
            icao24 = None

        departure = item.get("departure") or {}
        arrival = item.get("arrival") or {}
        airline = item.get("airline") or {}
        if not isinstance(departure, dict):
            departure = {}
        if not isinstance(arrival, dict):
            arrival = {}
        if not isinstance(airline, dict):
            airline = {}

        identity = (
            icao24,
            item.get("flight_date"),
            departure.get("iata"),
            arrival.get("iata"),
            flight.get("icao"),
            departure.get("scheduled"),
            arrival.get("scheduled"),
        )
        if identity in seen:
            continue
        seen.add(identity)

        results.append(
            {
                "flight_number": flight_iata,
                "callsign": (
                    flight.get("icao").strip().upper()
                    if isinstance(flight.get("icao"), str)
                    and flight.get("icao").strip()
                    else None
                ),
                "flight_date": item.get("flight_date"),
                "flight_status": item.get("flight_status"),
                "airline": airline.get("name"),
                "airline_iata": airline.get("iata"),
                "icao24": icao24,
                "aircraft_type": (
                    aircraft.get("iata")
                    or aircraft.get("icao")
                    or aircraft.get("model")
                ),
                "aircraft_iata": aircraft.get("iata"),
                "aircraft_icao": aircraft.get("icao"),
                "aircraft_registration": aircraft.get("registration"),
                "departure": {
                    "airport": departure.get("airport"),
                    "iata": departure.get("iata"),
                    "icao": departure.get("icao"),
                    "terminal": departure.get("terminal"),
                    "gate": departure.get("gate"),
                    "scheduled": departure.get("scheduled"),
                    "estimated": departure.get("estimated"),
                    "delay": departure.get("delay"),
                },
                "arrival": {
                    "airport": arrival.get("airport"),
                    "iata": arrival.get("iata"),
                    "icao": arrival.get("icao"),
                    "terminal": arrival.get("terminal"),
                    "gate": arrival.get("gate"),
                    "baggage": arrival.get("baggage"),
                    "scheduled": arrival.get("scheduled"),
                    "estimated": arrival.get("estimated"),
                    "delay": arrival.get("delay"),
                },
            }
        )

    if not results:
        raise FlightSearchError(
            404, f"No flights found for the exact flight number '{normalized}'."
        )
    return results