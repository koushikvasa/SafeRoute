"""One district forecast. Wind picks the neighbor that may fail next."""

import requests

LAT = 40.758
LON = -73.985


def fetch_weather_outlook():
    try:
        response = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": LAT,
                "longitude": LON,
                "current": "temperature_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m",
                "wind_speed_unit": "mph",
                "forecast_hours": 3,
            },
            timeout=8,
        )
        response.raise_for_status()
        current = response.json().get("current") or {}
        return {
            "source": "open-meteo",
            "lat": LAT,
            "lon": LON,
            "available": True,
            "temperature_c": current.get("temperature_2m"),
            "precipitation": current.get("precipitation"),
            "weather_code": current.get("weather_code"),
            "wind_mph": current.get("wind_speed_10m"),
            "wind_from_degrees": current.get("wind_direction_10m"),
            "summary": _summary(current),
        }
    except requests.RequestException:
        return {
            "source": "open-meteo",
            "lat": LAT,
            "lon": LON,
            "available": False,
            "wind_mph": None,
            "wind_from_degrees": None,
            "summary": "Weather unavailable. Using the scenario default direction.",
        }


def _summary(current):
    speed = current.get("wind_speed_10m")
    code = current.get("weather_code")
    rain = current.get("precipitation") or 0
    bits = []
    if speed is not None:
        bits.append(f"wind {round(speed)} mph")
    if rain:
        bits.append("rain")
    elif code in {45, 48}:
        bits.append("fog")
    elif code in {95, 96, 99}:
        bits.append("thunderstorm")
    return ", ".join(bits) or "clear"
