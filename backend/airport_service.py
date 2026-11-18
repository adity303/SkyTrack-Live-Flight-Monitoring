import csv 
from pathlib import Path 

AIRPORT_FILE = (
    Path(__file__).resolve().parent.parent
    / "data"
    / "airports.csv"
)

def get_airport(icao_code):
    if not icao_code:
        return None

    wanted = icao_code.strip().upper()

    with open(
        AIRPORT_FILE,
        "r",
        encoding="utf-8",
    ) as file:

        reader = csv.DictReader(file)

        for row in reader:
            ident = (row.get("ident") or "").upper()
            icao = (row.get("icao_code") or "").upper()
            iata = (row.get("iata_code") or "").upper()

            if wanted in (ident, icao, iata):
                return {
                    "icao": row["ident"],
                    "iata": row["iata_code"] or None,
                    "name": row["name"],
                    "latitude": float(row["latitude_deg"]),
                    "longitude": float(row["longitude_deg"]),
                    "municipality": row["municipality"],
                    "country": row["iso_country"],
                    "type": row["type"],
                }
        return None
        