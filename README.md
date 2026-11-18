# SkyTrack — Live Flight Monitoring

SkyTrack is a real-time flight tracking application built with FastAPI and Leaflet. It provides live aircraft telemetry, route visualization, historical tracking, and exportable flight reports.

## Features

- **Live Flight Tracking** — Real-time position, altitude, speed, heading, and vertical rate via OpenSky Network API
- **Flight Search** — Search by flight number (e.g., `AI101`) or ICAO24 hex identifier
- **Interactive Map** — Leaflet-based map showing aircraft position, departure/arrival airports, live route, planned route, and historical trajectory
- **Route Information** — Departure/arrival airports, planned distance, progress bar with estimated arrival (ETA)
- **Flight Analytics** — Distance covered, planned distance, duration, waypoints tracked
- **Tracking History** — Persistent SQLite storage of position updates with timestamped history
- **Export Reports** — Generate CSV, Excel (.xlsx), or PDF reports for:
  - Tracking History
  - Route Details
  - Flight Statistics
- **Health Monitoring** — `/health` endpoint with database and frontend status
- **Configurable** — Host, port, database path, poll interval, and OpenSky base URL via `config.json`

## Sample Pictures 
1. Main Dashboard --> <img width="1883" height="902" alt="Screenshot 2026-11-18 221958" src="https://github.com/user-attachments/assets/5583eea1-5691-412a-8d7d-228c3c53f0df" />
2. Aircraft Tracking --> <img width="1858" height="865" alt="Screenshot 2026-11-18 222232" src="https://github.com/user-attachments/assets/74b29aad-1392-4d4e-965e-3437dacca802" />
Another flight tracking --> <img width="1845" height="865" alt="Screenshot 2026-11-18 222423" src="https://github.com/user-attachments/assets/26831b1d-22df-4ef9-a56e-9536155165e0" /> Flight Map --> <img width="1435" height="612" alt="Screenshot 2026-11-18 222503" src="https://github.com/user-attachments/assets/e3c9c610-97b3-4213-b3e2-d5401b6a62ab" />



## Architecture

```
SkyTrack/
├── backend/                 # FastAPI application
│   ├── main.py             # API routes, server entry point
│   ├── airport_service.py  # Airport data (CSV lookup)
│   ├── flight_api.py       # AviationStack flight number search
│   ├── flight_service.py   # Flight data processing
│   ├── route_engine.py     # Route calculations, haversine distance
│   ├── reports.py          # CSV/Excel/PDF report generation
│   ├── database.py         # SQLite helpers
│   ├── requirements.txt    # Python dependencies
│   └── .env                # Environment variables (AVIATIONSTACK_API_KEY)
├── frontend/               # Static assets served by FastAPI
│   ├── index.html          # Main dashboard
│   ├── flight.html         # Flight detail page
│   ├── css/style.css       # Styling
│   └── js/                 # Client-side logic
│       ├── app.js          # Main application controller
│       ├── map.js          # Leaflet map handling
│       └── flight.js       # Flight data formatting
├── data/
│   ├── airports.csv        # Airport reference data
│   └── flights.db          # (Legacy) Flight database
├── config.json             # Runtime configuration
├── run_skytrack.bat        # Windows launcher script
└── .gitignore
```

## Requirements

- **Python 3.10+**
- **OpenSky Network** — Free account recommended for higher rate limits
- **AviationStack API key** (optional) — For flight number search functionality

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/yourusername/skytrack.git
cd skytrack
```

### 2. Install Python Dependencies

```bash
cd backend
pip install -r requirements.txt
cd ..
```

### 3. Configure (Optional)

Edit `config.json` to customize:
```json
{
  "host": "127.0.0.1",
  "port": 8000,
  "frontend_dir": "frontend",
  "database_path": "backend/skytrack_history.db",
  "open_browser": true,
  "opensky_base_url": "https://opensky-network.org/api",
  "poll_interval_ms": 15000
}
```

Set `AVIATIONSTACK_API_KEY` in `backend/.env` for flight number search:
```env
AVIATIONSTACK_API_KEY=your_api_key_here
```

### 4. Run

**Windows (recommended):**
```bash
run_skytrack.bat
```

**Manual (any OS):**
```bash
cd backend
python main.py
```

The application will be available at `http://127.0.0.1:8000` (or your configured host/port).

## Usage

1. **Search for a flight** — Enter a flight number (e.g., `AI101`, `BA178`) in the search box
2. **Or track by ICAO24** — Enter a 6-character hex ICAO24 identifier (e.g., `80073c`)
3. **Click "Track"** — Live telemetry begins polling at the configured interval
4. **View the map** — Aircraft position, route, and airports update in real-time
5. **Export reports** — Use the "Flight Reports" panel to download CSV/Excel/PDF

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Main dashboard |
| `GET /health` | Health check (DB + frontend status) |
| `GET /js/config.js` | Frontend runtime config |
| `GET /flight/{icao24}` | Live aircraft state |
| `GET /flight/{icao24}/track` | Historical trajectory |
| `GET /flight/{icao24}/airports` | Recent departure/arrival airports |
| `GET /flight/{icao24}/route` | Current route with departure/arrival |
| `GET /flight/{icao24}/trajectory` | Full trajectory with progress & ETA |
| `GET /flight-history/{icao24}` | Stored position history |
| `GET /search/{flight_number}` | Search by flight number (AviationStack) |
| `GET /airport/{icao}` | Airport details |
| `GET /flight/{icao24}/reports/tracking-history` | Export tracking history |
| `GET /flight/{icao24}/reports/route-details` | Export route details |
| `GET /flight/{icao24}/reports/flight-statistics` | Export flight statistics |

Report formats: `?format=csv|excel|pdf`

## Configuration

### config.json

| Key | Default | Description |
|-----|---------|-------------|
| `host` | `127.0.0.1` | Bind address |
| `port` | `8000` | Port number |
| `frontend_dir` | `frontend` | Path to static assets |
| `database_path` | `backend/skytrack_history.db` | SQLite database file |
| `open_browser` | `true` | Auto-open browser on start |
| `opensky_base_url` | `https://opensky-network.org/api` | OpenSky API base |
| `poll_interval_ms` | `15000` | Frontend poll interval |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `SKYTRACK_HOST` | Override config.json host |
| `SKYTRACK_PORT` | Override config.json port |
| `AVIATIONSTACK_API_KEY` | Enable flight number search |

## Data Sources

- **OpenSky Network** — Live ADS-B data (positions, trajectories, airport schedules)
- **airports.csv** — Local airport reference (ICAO, IATA, coordinates, metadata)
- **AviationStack** (optional) — Flight number to ICAO24 resolution

## Report Generation

Reports use:
- **openpyxl** — Excel (.xlsx) output
- **reportlab** — PDF output
- **csv** — Standard library

Reports are generated on-demand and streamed as file downloads.

## License

MIT License — feel free to use, modify, and distribute.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Troubleshooting

**Port already in use:**
```bash
# Change port in config.json or set SKYTRACK_PORT=8001
```

**OpenSky 403/rate limited:**
- Create a free OpenSky account for higher limits
- Or configure `opensky_base_url` to a different provider

**Frontend not loading:**
- Ensure `frontend/index.html` exists
- Check `config.json` frontend_dir path

**Flight number search not working:**
- Add `AVIATIONSTACK_API_KEY` to `backend/.env`
- Get a free key at aviationstack.com
