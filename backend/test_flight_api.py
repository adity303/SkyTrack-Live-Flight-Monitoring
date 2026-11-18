import os
import unittest
from unittest.mock import Mock, patch

from fastapi import HTTPException

from flight_api import FlightSearchError, search_flight_number
from main import get_flight


class FlightSearchTests(unittest.TestCase):
    @patch.dict(os.environ, {"AVIATIONSTACK_API_KEY": "test-key"})
    @patch("flight_api.requests.get")
    def test_search_returns_only_exact_flight_number_matches(self, get):
        response = Mock()
        response.json.return_value = {
            "data": [
                {
                    "flight": {"iata": "AI101", "icao": "AIC101"},
                    "aircraft": {"icao24": "ABC123", "registration": "VT-ABC"},
                    "flight_date": "2026-11-17",
                    "flight_status": "active",
                    "airline": {"name": "Air India"},
                    "departure": {"iata": "DEL", "airport": "Delhi"},
                    "arrival": {"iata": "LHR", "airport": "London"},
                },
                {"flight": {"iata": "AI1010"}, "aircraft": {"icao24": "DEF456"}},
            ]
        }
        get.return_value = response

        results = search_flight_number(" ai 101 ")

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["flight_number"], "AI101")
        self.assertEqual(results[0]["icao24"], "abc123")
        get.assert_called_once()
        self.assertEqual(get.call_args.kwargs["params"]["flight_iata"], "AI101")

    @patch.dict(os.environ, {"AVIATIONSTACK_API_KEY": "test-key"})
    @patch("flight_api.requests.get")
    def test_search_exposes_aircraft_and_airport_details(self, get):
        response = Mock()
        response.json.return_value = {
            "data": [
                {
                    "flight": {"iata": "AI101", "icao": "AIC101"},
                    "aircraft": {
                        "icao24": "ABC123",
                        "registration": "VT-ABC",
                        "iata": "A320",
                        "icao": "A320",
                    },
                    "flight_date": "2026-11-17",
                    "flight_status": "active",
                    "airline": {"name": "Air India", "iata": "AI"},
                    "departure": {
                        "iata": "DEL",
                        "icao": "VIDP",
                        "airport": "Indira Gandhi International",
                        "terminal": "3",
                        "gate": "14",
                        "scheduled": "2026-11-17T06:00:00+00:00",
                        "estimated": "2026-11-17T06:10:00+00:00",
                    },
                    "arrival": {
                        "iata": "LHR",
                        "icao": "EGLL",
                        "airport": "Heathrow",
                        "terminal": "2",
                        "scheduled": "2026-11-17T09:30:00+00:00",
                    },
                }
            ]
        }
        get.return_value = response

        results = search_flight_number("AI101")

        flight = results[0]
        self.assertEqual(flight["aircraft_type"], "A320")
        self.assertEqual(flight["aircraft_registration"], "VT-ABC")
        self.assertEqual(flight["airline_iata"], "AI")
        self.assertEqual(flight["departure"]["icao"], "VIDP")
        self.assertEqual(flight["departure"]["terminal"], "3")
        self.assertEqual(flight["arrival"]["airport"], "Heathrow")
        self.assertEqual(
            flight["arrival"]["scheduled"], "2026-11-17T09:30:00+00:00"
        )

    def test_search_rejects_malformed_flight_number(self):
        with self.assertRaises(FlightSearchError) as error:
            search_flight_number("AI101*")

        self.assertEqual(error.exception.status_code, 422)

    @patch.dict(os.environ, {}, clear=True)
    def test_search_requires_provider_key(self):
        with self.assertRaises(FlightSearchError) as error:
            search_flight_number("AI101")

        self.assertEqual(error.exception.status_code, 503)

    @patch("main.requests.get")
    def test_live_position_rejects_a_different_callsign(self, get):
        response = Mock()
        response.json.return_value = {
            "states": [["abc123", "OTHER1 ", "India"]]
        }
        get.return_value = response

        with self.assertRaises(HTTPException) as error:
            get_flight("abc123", expected_callsign="AIC101")

        self.assertEqual(error.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
