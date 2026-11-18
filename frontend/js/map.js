const map = L.map("map", {
  zoomControl: false,
  worldCopyJump: true,
  minZoom: 3,
}).setView([22.5726, 88.3639], 4);

L.control.zoom({ position: "bottomright" }).addTo(map);
L.control
  .scale({ position: "bottomleft", imperial: true, metric: true })
  .addTo(map);

const standardLayer = L.tileLayer(
  "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
);
const satelliteLayer = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    maxNativeZoom: 19,
    maxZoom: 19,
    attribution:
      "&copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  },
);
const terrainLayer = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
  {
    maxNativeZoom: 18,
    maxZoom: 19,
    attribution:
      "&copy; Esri, DeLorme, NAVTEQ, TomTom, Intermap, and the GIS User Community",
  },
);
standardLayer.addTo(map);

const liveGroup = L.layerGroup().addTo(map);
const histGroup = L.layerGroup().addTo(map);

L.control
  .layers(
    {
      Standard: standardLayer,
      Satellite: satelliteLayer,
      Terrain: terrainLayer,
    },
    {
      "Live route & aircraft": liveGroup,
      "Historical route": histGroup,
    },
    { collapsed: true, position: "topleft" },
  )
  .addTo(map);

const aircraftMarkers = new Map();
const searchAircrafts = new Map();
let selectedAircraftId = null;
let travelledPath = [];
let liveRouteLine = null;
let plannedRouteLine = null;
let historicalRouteLine = null;
let departureMarker = null;
let arrivalMarker = null;
let historicalStart = null;
let historicalEnd = null;

const AIRCRAFT_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.2 15 10l6.3 3.2v2L15 14l-1.6 6.8-1.4 1-1.4-1L9 14l-6.3 1.2v-2L9 10l3-7.8Z"/></svg>';

function validCoordinate(latitude, longitude) {
  return (
    latitude != null &&
    longitude != null &&
    latitude !== "" &&
    longitude !== "" &&
    Number.isFinite(Number(latitude)) &&
    Number.isFinite(Number(longitude)) &&
    Math.abs(Number(latitude)) <= 90 &&
    Math.abs(Number(longitude)) <= 180
  );
}

function normalizePoint(point) {
  if (!point || !validCoordinate(point.latitude, point.longitude)) return null;
  return [Number(point.latitude), Number(point.longitude)];
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function formatObserved(value) {
  if (value == null || value === "") return "Unavailable";
  const numeric = Number(value);
  const date = new Date(
    Number.isFinite(numeric)
      ? numeric < 1e12
        ? numeric * 1000
        : numeric
      : value,
  );
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString();
}

function aircraftPopup(id, aircraft) {
  const callsign = aircraft.callsign?.trim() || id.toUpperCase();
  const altitude =
    aircraft.altitude == null
      ? "Unavailable"
      : `${Math.round(Number(aircraft.altitude) * 3.28084).toLocaleString()} ft`;
  const speed =
    aircraft.speed == null
      ? "Unavailable"
      : `${Math.round(Number(aircraft.speed) * 1.94384).toLocaleString()} kt`;

  return `<div class="aircraft-popup">
    <strong>${escapeHtml(callsign)}</strong>
    <span>Altitude: ${escapeHtml(altitude)}</span>
    <span>Speed: ${escapeHtml(speed)}</span>
    <span>Last observed: ${escapeHtml(formatObserved(aircraft.lastObserved))}</span>
  </div>`;
}

function aircraftIcon(heading, isSearchAircraft) {
  const rotation = Number.isFinite(Number(heading)) ? Number(heading) : 0;
  const searchClass = isSearchAircraft ? " aircraft-icon--search" : "";
  return L.divIcon({
    className: "aircraft-container",
    html: `<span class="aircraft-icon${searchClass}" style="transform: rotate(${rotation}deg)">${AIRCRAFT_SVG}</span>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
}

function removeAircraftMarker(id) {
  const entry = aircraftMarkers.get(id);
  if (!entry) return;
  if (entry.animationFrame != null) {
    cancelAnimationFrame(entry.animationFrame);
  }
  liveGroup.removeLayer(entry.marker);
  aircraftMarkers.delete(id);
}

function moveAircraftMarker(entry, position) {
  if (entry.animationFrame != null) {
    cancelAnimationFrame(entry.animationFrame);
  }

  const start = entry.marker.getLatLng();
  const startedAt = performance.now();
  const duration = 900;

  const animate = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - (1 - progress) ** 3;
    entry.marker.setLatLng([
      start.lat + (position[0] - start.lat) * eased,
      start.lng + (position[1] - start.lng) * eased,
    ]);

    if (progress < 1) {
      entry.animationFrame = requestAnimationFrame(animate);
    } else {
      entry.animationFrame = null;
    }
  };

  entry.animationFrame = requestAnimationFrame(animate);
}

function renderAircraft(id, aircraft, options = {}) {
  const position = normalizePoint(aircraft);
  if (!position) return null;

  let entry = aircraftMarkers.get(id);
  const previousHeading = entry?.heading ?? 0;
  const parsedHeading = Number(aircraft.heading);
  const targetHeading = Number.isFinite(parsedHeading)
    ? parsedHeading
    : previousHeading;
  const headingDelta = ((targetHeading - previousHeading + 540) % 360) - 180;
  const smoothHeading = entry ? previousHeading + headingDelta : targetHeading;

  if (!entry) {
    const marker = L.marker(position, {
      icon: aircraftIcon(smoothHeading, options.searchAircraft),
      title: aircraft.callsign?.trim() || id.toUpperCase(),
    }).addTo(liveGroup);
    marker.bindPopup(aircraftPopup(id, aircraft));
    entry = { marker, heading: smoothHeading, animationFrame: null };
    aircraftMarkers.set(id, entry);
  } else {
    moveAircraftMarker(entry, position);
    entry.heading = smoothHeading;
    const iconElement = entry.marker
      .getElement()
      ?.querySelector(".aircraft-icon");
    if (iconElement) {
      iconElement.style.transform = `rotate(${smoothHeading}deg)`;
      iconElement.classList.toggle(
        "aircraft-icon--search",
        Boolean(options.searchAircraft),
      );
    } else {
      entry.marker.setIcon(aircraftIcon(smoothHeading, options.searchAircraft));
    }
    entry.marker.options.title = aircraft.callsign?.trim() || id.toUpperCase();
    entry.marker.setPopupContent(aircraftPopup(id, aircraft));
  }

  return entry;
}

function setSearchAircrafts(aircrafts) {
  const nextAircrafts = new Map();
  for (const aircraft of aircrafts || []) {
    const id = String(aircraft.icao24 || "")
      .trim()
      .toLowerCase();
    if (!id || !normalizePoint(aircraft)) continue;
    nextAircrafts.set(id, aircraft);
  }

  for (const id of searchAircrafts.keys()) {
    if (!nextAircrafts.has(id) && id !== selectedAircraftId) {
      removeAircraftMarker(id);
    }
  }

  searchAircrafts.clear();
  for (const [id, aircraft] of nextAircrafts) {
    searchAircrafts.set(id, aircraft);
    if (id !== selectedAircraftId) {
      renderAircraft(id, aircraft, { searchAircraft: true });
    }
  }
}

function updateAircraft(latitude, longitude, heading, callsign, details = {}) {
  const id = String(details.icao24 || details.id || "selected").toLowerCase();
  if (selectedAircraftId && selectedAircraftId !== id) resetMap();
  selectedAircraftId = id;

  const previous = searchAircrafts.get(id) || {};
  const aircraft = {
    ...previous,
    ...details,
    latitude,
    longitude,
    heading,
    callsign: callsign || details.callsign || previous.callsign,
  };
  renderAircraft(id, aircraft, { searchAircraft: false });
}

function resetAircraft() {
  if (!selectedAircraftId) return;
  const id = selectedAircraftId;
  selectedAircraftId = null;

  const searchAircraft = searchAircrafts.get(id);
  if (searchAircraft) {
    renderAircraft(id, searchAircraft, { searchAircraft: true });
  } else {
    removeAircraftMarker(id);
  }
}

function setRoute(departure, arrival) {
  clearRoute();
  const departurePosition = normalizePoint(departure);
  const arrivalPosition = normalizePoint(arrival);

  if (departurePosition) {
    departureMarker = L.marker(departurePosition, {
      icon: L.divIcon({
        className: "airport-container",
        html: '<span class="airport-icon airport-icon--departure">D</span>',
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
      title: `Departure: ${departure.name || departure.iata || departure.icao || "Airport"}`,
    }).addTo(histGroup);
    departureMarker.bindPopup(
      `<strong>Departure</strong><br>${escapeHtml(
        departure.name ||
          departure.municipality ||
          departure.iata ||
          departure.icao ||
          "Airport",
      )}`,
    );
  }

  if (arrivalPosition) {
    arrivalMarker = L.marker(arrivalPosition, {
      icon: L.divIcon({
        className: "airport-container",
        html: '<span class="airport-icon airport-icon--arrival">A</span>',
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
      title: `Arrival: ${arrival.name || arrival.iata || arrival.icao || "Airport"}`,
    }).addTo(histGroup);
    arrivalMarker.bindPopup(
      `<strong>Arrival</strong><br>${escapeHtml(
        arrival.name ||
          arrival.municipality ||
          arrival.iata ||
          arrival.icao ||
          "Airport",
      )}`,
    );
  }

  if (departurePosition && arrivalPosition) {
    plannedRouteLine = L.polyline([departurePosition, arrivalPosition], {
      color: "#38a3ff",
      weight: 3,
      opacity: 0.8,
      dashArray: "10 8",
    }).addTo(histGroup);
  }
}

function clearRoute() {
  if (plannedRouteLine) histGroup.removeLayer(plannedRouteLine);
  if (departureMarker) histGroup.removeLayer(departureMarker);
  if (arrivalMarker) histGroup.removeLayer(arrivalMarker);
  plannedRouteLine = null;
  departureMarker = null;
  arrivalMarker = null;
}

function updateTrajectory(points, options = {}) {
  const validPoints = (points || [])
    .map((point) => ({
      position: normalizePoint(point),
      timestamp: Number(
        point.timestamp ?? point.time_position ?? point.last_contact,
      ),
    }))
    .filter((point) => point.position);

  if (validPoints.some((point) => Number.isFinite(point.timestamp))) {
    validPoints.sort((a, b) => a.timestamp - b.timestamp);
  }

  travelledPath = validPoints.map((point) => point.position);
  if (liveRouteLine) liveGroup.removeLayer(liveRouteLine);
  liveRouteLine =
    travelledPath.length > 1
      ? L.polyline(travelledPath, {
          color: "#22d3ee",
          weight: 4,
          opacity: 0.9,
        }).addTo(liveGroup)
      : null;

  if (options.fit && travelledPath.length > 1) {
    map.fitBounds(L.latLngBounds(travelledPath), { padding: [36, 36] });
  }
}

function clearTrajectory() {
  travelledPath = [];
  if (liveRouteLine) liveGroup.removeLayer(liveRouteLine);
  liveRouteLine = null;
}

function drawHistoricalTrack(waypoints) {
  clearHistoricalTrack();
  const points = (waypoints || []).map(normalizePoint).filter(Boolean);
  if (points.length < 2) return;

  historicalRouteLine = L.polyline(points, {
    color: "#a78bfa",
    weight: 3,
    opacity: 0.85,
    dashArray: "3 7",
  }).addTo(histGroup);
  historicalStart = L.circleMarker(points[0], {
    radius: 5,
    color: "#c4b5fd",
    fillColor: "#7c3aed",
    fillOpacity: 1,
  }).addTo(histGroup);
  historicalEnd = L.circleMarker(points[points.length - 1], {
    radius: 5,
    color: "#ddd6fe",
    fillColor: "#a78bfa",
    fillOpacity: 1,
  }).addTo(histGroup);
}

function clearHistoricalTrack() {
  for (const layer of [historicalRouteLine, historicalStart, historicalEnd]) {
    if (layer) histGroup.removeLayer(layer);
  }
  historicalRouteLine = null;
  historicalStart = null;
  historicalEnd = null;
}

function fitToRoute() {
  const points = [];
  if (departureMarker) points.push(departureMarker.getLatLng());
  if (arrivalMarker) points.push(arrivalMarker.getLatLng());

  if (points.length === 0 && selectedAircraftId) {
    const entry = aircraftMarkers.get(selectedAircraftId);
    if (entry) points.push(entry.marker.getLatLng());
  }

  if (points.length > 1) {
    map.fitBounds(L.latLngBounds(points), {
      padding: [48, 48],
      maxZoom: 8,
    });
  } else if (points.length === 1) {
    map.setView(points[0], Math.max(map.getZoom(), 6));
  }
}

function resetMap() {
  resetAircraft();
  clearRoute();
  clearHistoricalTrack();
  clearTrajectory();
}

window.setSearchAircrafts = setSearchAircrafts;
window.updateAircraft = updateAircraft;
window.resetAircraft = resetAircraft;
window.setRoute = setRoute;
window.clearRoute = clearRoute;
window.updateTrajectory = updateTrajectory;
window.clearTrajectory = clearTrajectory;
window.drawHistoricalTrack = drawHistoricalTrack;
window.clearHistoricalTrack = clearHistoricalTrack;
window.fitToRoute = fitToRoute;
window.resetMap = resetMap;

map.whenReady(() => {
  map.invalidateSize();
});
