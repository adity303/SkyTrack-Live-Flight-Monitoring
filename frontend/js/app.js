const SKYTRACK_CONFIG = window.SKYTRACK_CONFIG || {};
const API_BASE = typeof SKYTRACK_CONFIG.apiBase === "string" ? SKYTRACK_CONFIG.apiBase : "";
const POLL_INTERVAL = Number(SKYTRACK_CONFIG.pollIntervalMs) || 15000;
const TRAJECTORY_REFRESH_EVERY = 4;
const HISTORY_LIMIT = 40;

const $ = (id) => document.getElementById(id);

const el = {
  flightNumber: $("flightNumber"),
  searchFlightButton: $("searchFlightButton"),
  flightChoices: $("flightChoices"),
  flightResults: $("flightResults"),
  flightIdentifier: $("flightIdentifier"),
  trackButton: $("trackButton"),
  stopButton: $("stopButton"),
  message: $("message"),
  autoRefresh: $("autoRefresh"),
  lastUpdated: $("lastUpdated"),
  liveStatus: $("liveStatus"),
  liveStatusText: $("liveStatusText"),
  utcClock: $("utcClock"),

  overviewFlightNumber: $("overviewFlightNumber"),
  overviewAirline: $("overviewAirline"),
  overviewStatus: $("overviewStatus"),
  overviewCallsign: $("overviewCallsign"),
  overviewAircraft: $("overviewAircraft"),
  overviewRegistration: $("overviewRegistration"),

  telemetryHint: $("telemetryHint"),
  altitude: $("altitude"),
  altitudeFoot: $("altitudeFoot"),
  speed: $("speed"),
  speedFoot: $("speedFoot"),
  heading: $("heading"),
  headingFoot: $("headingFoot"),
  verticalSpeed: $("verticalSpeed"),
  verticalSpeedFoot: $("verticalSpeedFoot"),

  routeHint: $("routeHint"),
  routeDepartureCode: $("routeDepartureCode"),
  routeDepartureCity: $("routeDepartureCity"),
  routeDepartureTime: $("routeDepartureTime"),
  routeArrivalCode: $("routeArrivalCode"),
  routeArrivalCity: $("routeArrivalCity"),
  routeArrivalTime: $("routeArrivalTime"),
  routeProgress: $("routeProgress"),
  routeProgressFill: $("routeProgressFill"),
  routePlane: $("routePlane"),
  routeProgressPercent: $("routeProgressPercent"),
  distanceCovered: $("distanceCovered"),
  distanceRemaining: $("distanceRemaining"),
  etaTime: $("etaTime"),

  analyticsHint: $("analyticsHint"),
  analyticsDistance: $("analyticsDistance"),
  analyticsPlanned: $("analyticsPlanned"),
  analyticsDuration: $("analyticsDuration"),
  analyticsEta: $("analyticsEta"),
  analyticsWaypoints: $("analyticsWaypoints"),

  mapHint: $("mapHint"),
  historyHint: $("historyHint"),
  historyList: $("historyList"),
  historyButton: $("historyButton"),

  reportType: $("reportType"),
  reportFormat: $("reportFormat"),
  exportReportButton: $("exportReportButton"),
  reportsMessage: $("reportsMessage"),
};

const state = {
  icao24: null,
  meta: null,
  flight: null,
  route: null,
  trajectory: null,
  history: [],
  positions: [],
  expectedCallsign: null,
  tracking: false,
  pending: false,
  pollCount: 0,
  pollTimer: null,
  firstSeenAt: null,
  externalProbed: false,
};

let flightSearchResults = [];
let searchMapRequestId = 0;

/* ============================== BOOT ============================== */

el.searchFlightButton.addEventListener("click", trackByFlightNumber);
el.flightNumber.addEventListener("keydown", (event) => {
  if (event.key === "Enter") trackByFlightNumber();
});
el.trackButton.addEventListener("click", () => {
  trackFlightByIdentifier(el.flightIdentifier.value);
});
el.flightIdentifier.addEventListener("keydown", (event) => {
  if (event.key === "Enter") trackFlightByIdentifier(el.flightIdentifier.value);
});
el.stopButton.addEventListener("click", () => stopTracking(false));
el.autoRefresh.addEventListener("change", handleAutoRefreshChange);
el.historyButton.addEventListener("click", loadHistoricalRoute);
el.exportReportButton.addEventListener("click", exportReport);

startClock();
renderRoute();
renderAnalytics();
renderTelemetry(null);
renderOverview(null);

/* ============================== HELPERS ============================== */

function startClock() {
  const tick = () => {
    el.utcClock.textContent = `${new Date().toISOString().slice(11, 19)} UTC`;
  };
  tick();
  setInterval(tick, 1000);
}

function showMessage(message, kind = "info") {
  el.message.textContent = message;
  if (kind === "info") {
    el.message.removeAttribute("data-kind");
  } else {
    el.message.dataset.kind = kind;
  }
}

function setLiveState(mode) {
  el.liveStatus.dataset.state = mode;
  el.liveStatusText.textContent =
    mode === "live" ? "LIVE" : mode === "error" ? "NO SIGNAL" : "STANDBY";
}

function setStatusBadge(label, stateName) {
  el.overviewStatus.textContent = label;
  el.overviewStatus.dataset.state = stateName;
}

function formatAirportCode(airport) {
  if (!airport) return null;
  return airport.iata || airport.icao || null;
}

function formatAirportLabel(airport) {
  if (!airport) return "Unknown";
  const code = formatAirportCode(airport);
  if (airport.airport && code) return `${airport.airport} (${code})`;
  return airport.airport || code || "Unknown";
}

function flightStatusLabel(status) {
  if (!status) return "Unknown";
  return String(status).replace(/_/g, " ");
}

function aircraftTypeLabel(flight) {
  return (
    flight.aircraft_type ||
    flight.aircraft_iata ||
    flight.aircraft_icao ||
    flight.aircraft_registration ||
    "Unknown"
  );
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function clampPercent(value) {
  if (value == null || Number.isNaN(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function metersToFeet(meters) {
  return meters * 3.28084;
}

function mpsToKnots(mps) {
  return mps * 1.94384;
}

function mpsToFpm(mps) {
  return mps * 196.8504;
}

function headingToCardinal(degrees) {
  const points = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
  ];
  return points[Math.round(degrees / 22.5) % 16];
}

function formatNumber(value, digits = 0) {
  if (value == null || Number.isNaN(value)) return "--";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatDistance(km) {
  if (km == null || Number.isNaN(km)) return "--";
  return `${formatNumber(km, 1)} km`;
}

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(seconds) || seconds < 0) return "--";

  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

function toDate(value) {
  if (value == null || value === "") return null;

  if (typeof value === "number") {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatClock(value, withSeconds = false) {
  const date = toDate(value);
  if (!date) return "--";

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
  });
}

function formatRelativeEta(value) {
  const date = toDate(value);
  if (!date) return null;

  const diffMinutes = Math.round((date.getTime() - Date.now()) / 60000);
  if (diffMinutes <= 0) return null;

  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  if (hours <= 0) return `in ${minutes}m`;
  return `in ${hours}h ${String(minutes).padStart(2, "0")}m`;
}

function observationLabel(flight) {
  const observation = flight?.time_position || flight?.last_contact;
  const date = toDate(observation);
  if (date) return date.toLocaleString();
  return new Date().toLocaleTimeString();
}

async function fetchJson(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
    try {
      const error = await response.json();
      detail = error.detail || detail;
    } catch {
      /* keep the HTTP status message */
    }
    throw new Error(detail);
  }

  return response.json();
}

/* ============================ SEARCH / TRACKING ============================ */

async function trackByFlightNumber() {
  const flightNumber = el.flightNumber.value.trim().replace(/\s+/g, "").toUpperCase();

  if (!flightNumber) {
    showMessage("Enter a flight number (e.g. AI101).", "error");
    return;
  }

  el.searchFlightButton.disabled = true;
  el.flightChoices.hidden = true;
  searchMapRequestId += 1;
  setSearchAircrafts([]);
  showMessage(`Searching for flight ${flightNumber}...`);

  try {
    const data = await fetchJson(`/search/${encodeURIComponent(flightNumber)}`);
    const results = data.results || [];

    if (results.length === 0) throw new Error("No matching flights found.");

    const noun = results.length === 1 ? "flight" : "flights";
    presentFlightResults(
      results,
      `Found ${results.length} matching ${noun} for ${flightNumber}. Select the flight you want to track.`,
    );
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    el.searchFlightButton.disabled = false;
  }
}

function createResultRow(label, value) {
  const row = document.createElement("div");
  row.className = "result-card__row";

  const labelEl = document.createElement("span");
  labelEl.className = "result-card__label";
  labelEl.textContent = label;

  const valueEl = document.createElement("span");
  valueEl.className = "result-card__value";
  valueEl.textContent = value;

  row.append(labelEl, valueEl);
  return row;
}

function presentFlightResults(results, message) {
  flightSearchResults = results;
  loadSearchAircrafts(results);
  el.flightResults.replaceChildren();

  results.forEach((flight, index) => {
    const canTrack = Boolean(flight.icao24);

    const card = document.createElement("div");
    card.className = "result-card";
    if (!canTrack) card.classList.add("result-card--disabled");
    card.dataset.index = String(index);
    card.setAttribute("role", "option");
    card.setAttribute("aria-disabled", canTrack ? "false" : "true");
    card.tabIndex = canTrack ? 0 : -1;

    const header = document.createElement("div");
    header.className = "result-card__header";

    const number = document.createElement("span");
    number.className = "result-card__number";
    number.textContent = flight.flight_number || "Flight";

    const airline = document.createElement("span");
    airline.className = "result-card__airline";
    airline.textContent = flight.airline || "Unknown airline";

    header.append(number, airline);

    const route = document.createElement("div");
    route.className = "result-card__route";
    route.textContent = `${formatAirportLabel(flight.departure)}  →  ${formatAirportLabel(flight.arrival)}`;

    const details = document.createElement("div");
    details.className = "result-card__details";
    details.append(
      createResultRow("Callsign", flight.callsign?.trim() || "—"),
      createResultRow("Flight status", flightStatusLabel(flight.flight_status)),
      createResultRow("Aircraft", aircraftTypeLabel(flight)),
      createResultRow("Registration", flight.aircraft_registration || "—"),
      createResultRow("Date", flight.flight_date || "—"),
    );

    const trackBtn = document.createElement("button");
    trackBtn.type = "button";
    trackBtn.className = "btn result-card__track";
    trackBtn.textContent = canTrack ? "Track this flight" : "No aircraft data";
    trackBtn.disabled = !canTrack;
    trackBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      trackSelectedFlight(index);
    });

    card.append(header, route, details, trackBtn);

    if (canTrack) {
      card.addEventListener("click", () => trackSelectedFlight(index));
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          trackSelectedFlight(index);
        }
      });
    }

    el.flightResults.appendChild(card);
  });

  el.flightChoices.hidden = false;
  showMessage(message);
}

async function loadSearchAircrafts(results) {
  const requestId = ++searchMapRequestId;
  setSearchAircrafts([]);
  const candidates = results.filter((flight) => flight.icao24);
  const aircrafts = [];

  for (let offset = 0; offset < candidates.length; offset += 4) {
    const batch = candidates.slice(offset, offset + 4);
    const outcomes = await Promise.allSettled(
      batch.map(async (flight) => {
        const callsign = flight.callsign?.trim();
        const path = `/flight/${encodeURIComponent(flight.icao24)}${
          callsign ? `?expected_callsign=${encodeURIComponent(callsign)}` : ""
        }`;
        const position = await fetchJson(path);
        if (position.latitude == null || position.longitude == null) return null;

        return {
          icao24: flight.icao24,
          latitude: position.latitude,
          longitude: position.longitude,
          heading: position.heading,
          callsign: position.callsign?.trim() || callsign || flight.flight_number,
          altitude: position.geo_altitude ?? position.altitude,
          speed: position.velocity,
          lastObserved: position.time_position || position.last_contact,
        };
      }),
    );

    if (requestId !== searchMapRequestId) return;
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled" && outcome.value) {
        aircrafts.push(outcome.value);
      }
    }
    setSearchAircrafts(aircrafts);
  }
}

function trackSelectedFlight(index) {
  const selectedFlight = flightSearchResults[index];

  if (!selectedFlight?.icao24) {
    showMessage("Select a flight with an available aircraft identifier.", "error");
    return;
  }

  startTracking({
    icao24: selectedFlight.icao24,
    meta: selectedFlight,
    expectedCallsign: selectedFlight.callsign || null,
  });
}

async function trackFlightByIdentifier(identifier) {
  const trimmed = identifier.trim();

  if (!trimmed) {
    showMessage("Enter an aircraft identifier (ICAO24 or flight number).", "error");
    return;
  }

  if (/^[a-fA-F0-9]{6}$/.test(trimmed)) {
    searchMapRequestId += 1;
    setSearchAircrafts([]);
    startTracking({ icao24: trimmed.toLowerCase(), meta: null });
    return;
  }

  searchMapRequestId += 1;
  setSearchAircrafts([]);
  showMessage(`Resolving flight ${trimmed} to its aircraft identifier...`);

  try {
    const data = await fetchJson(`/search/${encodeURIComponent(trimmed)}`);
    const results = data.results || [];

    if (results.length === 0) throw new Error("No matching flights found.");

    const noun = results.length === 1 ? "flight" : "flights";
    presentFlightResults(
      results,
      `Found ${results.length} matching ${noun} for ${trimmed}. Select the flight you want to track.`,
    );
  } catch (error) {
    showMessage(error.message, "error");
  }
}

function startTracking({ icao24, meta = null, expectedCallsign = null }) {
  resetMap();
  stopTracking(true);

  state.icao24 = icao24;
  state.meta = meta;
  state.expectedCallsign = expectedCallsign || meta?.callsign || null;
  state.tracking = true;
  state.pending = false;
  state.pollCount = 0;
  state.positions = [];
  state.firstSeenAt = null;
  state.flight = null;
  state.trajectory = null;
  state.route = null;
  state.externalProbed = false;

  el.trackButton.disabled = true;
  el.stopButton.disabled = false;
  el.autoRefresh.checked = true;
  el.flightChoices.hidden = true;
  el.exportReportButton.disabled = false;

  setLiveState("live");
  renderOverview(null);
  renderRoute();
  renderAnalytics();
  showMessage(`Connecting to live aircraft data for ${icao24.toUpperCase()}...`);

  refreshLive(true)
    .then(() => loadRouteData(true))
    .then(() => loadHistory(true))
    .then(() => {
      if (state.tracking) {
        showMessage(
          `Tracking ${state.meta?.flight_number || state.expectedCallsign || state.icao24.toUpperCase()}.`,
          "success",
        );
      }
    });

  startPolling();
}

function startPolling() {
  stopPolling();
  if (!state.icao24) return;
  state.pollTimer = setInterval(() => refreshLive(false), POLL_INTERVAL);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function handleAutoRefreshChange() {
  if (el.autoRefresh.checked) {
    if (!state.icao24) {
      showMessage("Search for a flight first to enable auto-refresh.", "error");
      el.autoRefresh.checked = false;
      return;
    }
    startPolling();
    showMessage("Auto-refresh enabled (15s).");
  } else {
    stopPolling();
    showMessage("Auto-refresh disabled.");
  }
}

async function refreshLive(initial) {
  if (!state.icao24 || state.pending) return;
  state.pending = true;

  const icao = state.icao24;
  const path = `/flight/${icao}${
    state.expectedCallsign
      ? `?expected_callsign=${encodeURIComponent(state.expectedCallsign)}`
      : ""
  }`;

  try {
    const flight = await fetchJson(path);
    if (state.icao24 !== icao) return;

    state.flight = flight;

    if (!state.firstSeenAt) state.firstSeenAt = new Date();

    if (flight.latitude != null && flight.longitude != null) {
      const last = state.positions[state.positions.length - 1];
      if (
        !last ||
        last.latitude !== flight.latitude ||
        last.longitude !== flight.longitude
      ) {
        state.positions.push({
          latitude: flight.latitude,
          longitude: flight.longitude,
          timestamp: flight.time_position || flight.last_contact || Date.now(),
        });
      }

      updateAircraft(
        flight.latitude,
        flight.longitude,
        flight.heading,
        flight.callsign,
        {
          icao24: state.icao24,
          altitude: flight.geo_altitude ?? flight.altitude,
          speed: flight.velocity,
          lastObserved: flight.time_position || flight.last_contact,
        },
      );
    }

    renderOverview(flight);
    renderTelemetry(flight);
    renderRoute();
    renderAnalytics();

    el.lastUpdated.textContent = `Last updated: ${observationLabel(flight)}`;
    setLiveState("live");

    if (initial) {
      const callsign = flight.callsign?.trim();
      showMessage(
        `Live tracking active for ${callsign || state.icao24.toUpperCase()}.`,
        "success",
      );
    }

    state.pollCount += 1;
    if (state.pollCount % TRAJECTORY_REFRESH_EVERY === 0) {
      loadRouteData(false);
    }

    await loadHistory(false);
  } catch (error) {
    setLiveState("error");
    showMessage(error.message, "error");
  } finally {
    state.pending = false;
  }
}

function stopTracking(silent) {
  stopPolling();
  if (!silent) resetMap();

  const wasTracking = state.tracking;

  state.tracking = false;
  state.icao24 = null;
  state.meta = null;
  state.flight = null;
  state.route = null;
  state.trajectory = null;
  state.history = [];
  state.positions = [];
  state.expectedCallsign = null;
  state.firstSeenAt = null;
  state.pollCount = 0;
  state.pending = false;

  el.trackButton.disabled = false;
  el.stopButton.disabled = true;
  el.autoRefresh.checked = false;
  el.exportReportButton.disabled = true;

  resetDashboard();
  setLiveState("idle");

  if (!silent && wasTracking) {
    showMessage("Tracking stopped.");
  }
}

/* ============================ ROUTE / ANALYTICS ============================ */

async function loadRouteData(initial, force = false) {
  if (!state.icao24) return;

  const icao = state.icao24;
  const base = `/flight/${icao}`;

  const [localDeparture, localArrival] = await Promise.all([
    resolveMetaAirport("departure"),
    resolveMetaAirport("arrival"),
  ]);

  if (state.icao24 !== icao) return;

  if (state.meta || localDeparture || localArrival) {
    state.route = state.route || {};
    state.route.departure = mergeAirport(
      state.route.departure,
      state.meta?.departure,
      localDeparture,
    );
    state.route.arrival = mergeAirport(
      state.route.arrival,
      state.meta?.arrival,
      localArrival,
    );
    state.route.planned_distance_km = plannedRouteDistance(state.route);

    setRoute(state.route.departure, state.route.arrival);
  }

  renderRoute();
  renderAnalytics();

  if (initial) fitToRoute();

  if (!force && state.externalProbed) return;
  state.externalProbed = true;

  Promise.allSettled([
    fetchJson(`${base}/route`),
    fetchJson(`${base}/trajectory`),
  ]).then((outcomes) => {
    if (state.icao24 !== icao) return;

    if (outcomes[0].status === "fulfilled") {
      applyRoutePayload(outcomes[0].value);
    }

    if (outcomes[1].status === "fulfilled") {
      state.trajectory = outcomes[1].value;
    }

    renderRoute();
    renderAnalytics();

    if (initial) fitToRoute();
  });
}

function applyRoutePayload(payload) {
  const base = state.route || {};

  state.route = {
    ...base,
    ...payload,
    departure: mergeAirport(
      base.departure,
      state.meta?.departure,
      payload.departure,
    ),
    arrival: mergeAirport(base.arrival, state.meta?.arrival, payload.arrival),
  };

  state.route.planned_distance_km =
    payload.planned_distance_km ?? plannedRouteDistance(state.route);

  setRoute(state.route.departure, state.route.arrival);
}

async function resolveMetaAirport(kind) {
  const metaAirport =
    kind === "departure" ? state.meta?.departure : state.meta?.arrival;

  if (!metaAirport) return null;

  const codes = [metaAirport.icao, metaAirport.iata].filter(Boolean);
  if (codes.length === 0) return null;

  for (const code of codes) {
    try {
      const airport = await fetchJson(
        `/airport/${encodeURIComponent(code)}`,
      );

      if (airport && airport.latitude != null && airport.longitude != null) {
        return airport;
      }
    } catch {
      /* try the next identifier */
    }
  }

  return null;
}

function firstCoordinate(primary, secondary) {
  if (typeof primary === "number" && !Number.isNaN(primary)) return primary;
  if (typeof secondary === "number" && !Number.isNaN(secondary)) {
    return secondary;
  }
  return null;
}

function mergeAirport(baseAirport, metaAirport, resolved) {
  if (!baseAirport && !metaAirport && !resolved) return null;

  const base = baseAirport || {};
  const meta = metaAirport || {};
  const airport = resolved || {};

  return {
    icao: base.icao || airport.icao || meta.icao || null,
    iata: base.iata || airport.iata || meta.iata || null,
    name: base.name || airport.name || meta.airport || null,
    municipality:
      base.municipality || airport.municipality || meta.municipality || null,
    country: base.country || airport.country || meta.country || null,
    latitude: firstCoordinate(base.latitude, airport.latitude),
    longitude: firstCoordinate(base.longitude, airport.longitude),
    scheduled: meta.scheduled || base.scheduled || null,
    estimated: meta.estimated || base.estimated || null,
    terminal: meta.terminal || base.terminal || null,
    gate: meta.gate || base.gate || null,
  };
}

function plannedRouteDistance(route) {
  if (!route) return null;
  if (route.planned_distance_km != null) return route.planned_distance_km;

  const dep = route.departure;
  const arr = route.arrival;

  if (
    dep?.latitude != null &&
    dep?.longitude != null &&
    arr?.latitude != null &&
    arr?.longitude != null
  ) {
    return haversine(dep.latitude, dep.longitude, arr.latitude, arr.longitude);
  }

  return null;
}

async function loadHistory(initial) {
  if (!state.icao24) return;

  const icao = state.icao24;

  try {
    const history = await fetchJson(
      `/flight-history/${icao}?limit=${HISTORY_LIMIT}`,
    );

    if (state.icao24 !== icao) return;

    if (!Array.isArray(history) || history.length === 0) {
      state.history = [];
      renderHistory([]);
      updateTrajectory(state.positions, { fit: false });
      return;
    }

    state.history = history;
    renderHistory(history);
    updateTrajectory(history, { fit: Boolean(initial) && !state.route });
  } catch {
    if (state.icao24 === icao) {
      state.history = [];
      renderHistory([]);
    }
  }
}

function departure() {
  return state.route?.departure || state.meta?.departure || null;
}

function arrival() {
  return state.route?.arrival || state.meta?.arrival || null;
}

function progressPercent() {
  const percent = clampPercent(state.trajectory?.progress_percent);
  if (percent != null) return percent;

  const planned = state.route?.planned_distance_km;
  const flight = state.flight;
  const arrivalAirport = state.route?.arrival;

  if (
    planned &&
    planned > 0 &&
    flight?.latitude != null &&
    flight?.longitude != null &&
    arrivalAirport?.latitude != null &&
    arrivalAirport?.longitude != null
  ) {
    const remaining = haversine(
      flight.latitude,
      flight.longitude,
      arrivalAirport.latitude,
      arrivalAirport.longitude,
    );
    return clampPercent(((planned - remaining) / planned) * 100);
  }

  return null;
}

function remainingDistanceKm() {
  const fromTrajectory = state.trajectory?.remaining_distance_km;
  if (fromTrajectory != null) return fromTrajectory;

  const flight = state.flight;
  const arrivalAirport = state.route?.arrival;

  if (
    flight?.latitude != null &&
    flight?.longitude != null &&
    arrivalAirport?.latitude != null &&
    arrivalAirport?.longitude != null
  ) {
    return haversine(
      flight.latitude,
      flight.longitude,
      arrivalAirport.latitude,
      arrivalAirport.longitude,
    );
  }

  return null;
}

function coveredDistanceKm() {
  const fromTrajectory = state.trajectory?.actual_distance_km;
  if (fromTrajectory != null) return fromTrajectory;

  const planned = state.route?.planned_distance_km;
  const remaining = remainingDistanceKm();
  if (planned != null && remaining != null) {
    return Math.max(0, planned - remaining);
  }

  let total = 0;
  for (let i = 1; i < state.positions.length; i += 1) {
    total += haversine(
      state.positions[i - 1].latitude,
      state.positions[i - 1].longitude,
      state.positions[i].latitude,
      state.positions[i].longitude,
    );
  }

  return total > 0 ? total : null;
}

function estimatedArrival() {
  const fromTrajectory = toDate(state.trajectory?.estimated_arrival);
  if (fromTrajectory) return fromTrajectory;

  const remaining = remainingDistanceKm();
  const speedKts = state.flight?.velocity
    ? mpsToKnots(state.flight.velocity)
    : null;

  if (remaining != null && speedKts && speedKts > 0) {
    const hours = remaining / (speedKts * 1.852);
    return new Date(Date.now() + hours * 3600 * 1000);
  }

  const scheduledArrival = toDate(arrival()?.estimated || arrival()?.scheduled);
  return scheduledArrival;
}

function durationSeconds() {
  const fromTrajectory = state.trajectory?.total_duration_seconds;
  if (fromTrajectory) return fromTrajectory;

  const scheduledDeparture = toDate(departure()?.scheduled);
  if (scheduledDeparture) {
    return Math.max(0, (Date.now() - scheduledDeparture.getTime()) / 1000);
  }

  if (state.firstSeenAt) {
    return (Date.now() - state.firstSeenAt.getTime()) / 1000;
  }

  return null;
}

/* ============================== RENDERERS ============================== */

function renderOverview(flight) {
  const meta = state.meta;
  const icao = state.icao24;

  if (!flight && !meta && !icao) {
    el.overviewFlightNumber.textContent = "NO FLIGHT SELECTED";
    el.overviewAirline.textContent =
      "Search for a flight or enter an ICAO24 identifier to begin";
    setStatusBadge("UNKNOWN", "unknown");
    return;
  }

  const flightNumber =
    meta?.flight_number ||
    flight?.callsign?.trim() ||
    (icao ? icao.toUpperCase() : null) ||
    "UNKNOWN FLIGHT";

  el.overviewFlightNumber.textContent = flightNumber;
  el.overviewAirline.textContent =
    meta?.airline || flight?.origin_country || "Aircraft position unavailable";

  if (flight) {
    if (flight.on_ground) {
      setStatusBadge("ON GROUND", "ground");
    } else {
      setStatusBadge("AIRBORNE", "airborne");
    }
  } else if (meta?.flight_status) {
    const status = String(meta.flight_status).toLowerCase();
    if (status === "landed" || status === "cancelled" || status === "diverted") {
      setStatusBadge(status.toUpperCase(), "landed");
    } else {
      setStatusBadge("SCHEDULED", "ground");
    }
  } else {
    setStatusBadge("UNKNOWN", "unknown");
  }

  el.overviewCallsign.textContent =
    flight?.callsign?.trim() || meta?.callsign?.trim() || "--";
  el.overviewAircraft.textContent =
    (meta && aircraftTypeLabel(meta)) || "--";
  el.overviewRegistration.textContent = meta?.aircraft_registration || "--";

  document.title = `${flightNumber} | SkyTrack`;
}

function renderTelemetry(flight) {
  if (!flight) {
    el.altitude.textContent = "--";
    el.altitudeFoot.textContent = "barometric";
    el.speed.textContent = "--";
    el.speedFoot.textContent = "--";
    el.heading.textContent = "--";
    el.headingFoot.textContent = "--";
    el.verticalSpeed.textContent = "--";
    el.verticalSpeedFoot.textContent = "level";
    el.verticalSpeedFoot.removeAttribute("data-trend");
    el.telemetryHint.textContent = "Awaiting aircraft data";
    return;
  }

  const altitudeMeters = flight.geo_altitude ?? flight.altitude;
  const speedKts =
    flight.velocity == null ? null : mpsToKnots(flight.velocity);
  const heading =
    flight.heading == null ? null : (flight.heading + 360) % 360;
  const verticalFpm =
    flight.vertical_rate == null ? null : mpsToFpm(flight.vertical_rate);

  el.altitude.textContent =
    altitudeMeters == null
      ? "--"
      : formatNumber(metersToFeet(altitudeMeters), 0);

  el.altitudeFoot.textContent = flight.on_ground
    ? "on ground"
    : altitudeMeters == null
      ? "no data"
      : "barometric altitude";

  el.speed.textContent =
    speedKts == null ? "--" : formatNumber(speedKts, 0);
  el.speedFoot.textContent =
    speedKts == null ? "no data" : `${formatNumber(speedKts * 1.852, 0)} km/h`;

  el.heading.textContent =
    heading == null ? "--" : String(Math.round(heading) % 360).padStart(3, "0");
  el.headingFoot.textContent =
    heading == null ? "no data" : headingToCardinal(heading);

  el.verticalSpeed.textContent =
    verticalFpm == null
      ? "--"
      : `${verticalFpm > 0 ? "+" : ""}${formatNumber(verticalFpm, 0)}`;

  if (verticalFpm == null || Math.abs(verticalFpm) < 100) {
    el.verticalSpeedFoot.textContent =
      verticalFpm == null ? "no data" : "level flight";
    el.verticalSpeedFoot.removeAttribute("data-trend");
  } else if (verticalFpm > 0) {
    el.verticalSpeedFoot.textContent = "climbing";
    el.verticalSpeedFoot.dataset.trend = "up";
  } else {
    el.verticalSpeedFoot.textContent = "descending";
    el.verticalSpeedFoot.dataset.trend = "down";
  }

  el.telemetryHint.textContent = `Last contact ${formatClock(
    flight.time_position || flight.last_contact,
    true,
  )}`;
}

function renderRoute() {
  const dep = departure();
  const arr = arrival();

  const depCode = (dep && (dep.iata || dep.icao)) || "---";
  const arrCode = (arr && (arr.iata || arr.icao)) || "---";

  el.routeDepartureCode.textContent = depCode;
  el.routeArrivalCode.textContent = arrCode;
  el.routeDepartureCode.title = dep?.name || depCode;
  el.routeArrivalCode.title = arr?.name || arrCode;

  el.routeDepartureCity.textContent =
    dep?.municipality || dep?.city || dep?.airport || dep?.name || "Departure";
  el.routeArrivalCity.textContent =
    arr?.municipality || arr?.city || arr?.airport || arr?.name || "Arrival";

  el.routeDepartureCity.title = dep?.airport || dep?.name || depCode;
  el.routeArrivalCity.title = arr?.airport || arr?.name || arrCode;

  const metaDep = state.meta?.departure;
  const metaArr = state.meta?.arrival;

  el.routeDepartureTime.textContent = formatClock(
    metaDep?.scheduled || dep?.scheduled || metaDep?.estimated || dep?.estimated,
  );
  el.routeArrivalTime.textContent = formatClock(
    metaArr?.estimated || arr?.estimated || metaArr?.scheduled || arr?.scheduled,
  );

  el.routeHint.textContent =
    depCode !== "---" && arrCode !== "---"
      ? `${depCode} → ${arrCode}`
      : state.meta
        ? "Route unavailable"
        : "Search by flight number for route";

  const percent = progressPercent();
  const width = percent == null ? 0 : percent;

  el.routeProgressFill.style.width = `${width}%`;
  el.routePlane.style.left = `${width}%`;
  el.routeProgressPercent.textContent =
    percent == null ? "0%" : `${Math.round(percent)}%`;
  el.routeProgress.setAttribute(
    "aria-valuenow",
    percent == null ? "0" : String(Math.round(percent)),
  );

  el.distanceCovered.textContent = formatDistance(coveredDistanceKm());
  el.distanceRemaining.textContent = formatDistance(remainingDistanceKm());

  const eta = estimatedArrival();
  const relative = eta ? formatRelativeEta(eta) : null;
  el.etaTime.textContent = eta
    ? `${formatClock(eta)}${relative ? ` (${relative})` : ""}`
    : "--";
}

function renderAnalytics() {
  const covered = coveredDistanceKm();
  const remaining = remainingDistanceKm();
  const planned = state.route?.planned_distance_km ?? null;
  const eta = estimatedArrival();
  const relative = eta ? formatRelativeEta(eta) : null;

  el.analyticsDistance.textContent = formatDistance(covered);
  el.analyticsPlanned.textContent = formatDistance(planned);
  el.analyticsDuration.textContent = formatDuration(durationSeconds());
  el.analyticsEta.textContent = eta
    ? `${formatClock(eta)}${relative ? ` (${relative})` : ""}`
    : "--";
  el.analyticsWaypoints.textContent =
    state.trajectory?.total_waypoints != null
      ? formatNumber(state.trajectory.total_waypoints, 0)
      : state.history.length
        ? formatNumber(state.history.length, 0)
        : "--";

  if (state.trajectory) {
    el.analyticsHint.textContent = "Based on tracked trajectory";
  } else if (covered != null || remaining != null) {
    el.analyticsHint.textContent = "Estimates from last position";
  } else {
    el.analyticsHint.textContent = "No analytics data";
  }

  el.mapHint.textContent =
    planned != null && covered != null
      ? `${formatDistance(covered)} of ${formatDistance(planned)}`
      : "Aircraft position, airports and flight path";
}

function renderHistory(history) {
  el.historyList.replaceChildren();

  if (!history || history.length === 0) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "No tracking history available.";
    el.historyList.appendChild(empty);
    el.historyHint.textContent = "No history yet";
    return;
  }

  const fragment = document.createDocumentFragment();

  history.slice(0, 15).forEach((entry) => {
    const row = document.createElement("div");
    row.className = "history-item";

    const time = document.createElement("span");
    time.className = "history-item__time";
    time.textContent = formatClock(entry.timestamp, true);

    const body = document.createElement("span");
    body.className = "history-item__body";

    const position = document.createElement("span");
    position.textContent =
      entry.latitude != null && entry.longitude != null
        ? `${entry.latitude.toFixed(4)}, ${entry.longitude.toFixed(4)}`
        : "position unavailable";

    const altitude = document.createElement("span");
    const altitudeValue =
      entry.altitude == null ? "--" : `${formatNumber(metersToFeet(entry.altitude), 0)} ft`;
    altitude.innerHTML = `Alt <b>${altitudeValue}</b>`;

    const speed = document.createElement("span");
    const speedValue =
      entry.velocity == null
        ? "--"
        : `${formatNumber(mpsToKnots(entry.velocity), 0)} kt`;
    speed.innerHTML = `Spd <b>${speedValue}</b>`;

    body.append(position, altitude, speed);
    row.append(time, body);
    fragment.appendChild(row);
  });

  el.historyList.appendChild(fragment);
  el.historyHint.textContent = `${history.length} samples`;
}

function resetDashboard() {
  el.overviewFlightNumber.textContent = "NO FLIGHT SELECTED";
  el.overviewAirline.textContent =
    "Search for a flight or enter an ICAO24 identifier to begin";
  setStatusBadge("UNKNOWN", "unknown");
  el.overviewCallsign.textContent = "--";
  el.overviewAircraft.textContent = "--";
  el.overviewRegistration.textContent = "--";

  renderTelemetry(null);
  renderRoute();
  renderAnalytics();
  renderHistory([]);

  el.lastUpdated.textContent = "Last updated: --";
  el.routeHint.textContent = "Route unavailable";
  el.routeDepartureCode.textContent = "---";
  el.routeArrivalCode.textContent = "---";
  el.routeDepartureCity.textContent = "Departure";
  el.routeArrivalCity.textContent = "Arrival";
  el.routeDepartureTime.textContent = "--";
  el.routeArrivalTime.textContent = "--";
  el.routeProgressFill.style.width = "0%";
  el.routePlane.style.left = "0%";
  el.routeProgressPercent.textContent = "0%";
  el.distanceCovered.textContent = "--";
  el.distanceRemaining.textContent = "--";
  el.etaTime.textContent = "--";

  document.title = "SkyTrack | Live Flight Monitoring";
}

/* ============================ HISTORICAL ROUTE ============================ */

async function loadHistoricalRoute() {
  if (!state.icao24) {
    showMessage("Track an aircraft first.", "error");
    return;
  }

  el.historyButton.disabled = true;

  try {
    showMessage("Loading historical trajectory...");

    const data = await fetchJson(`/flight/${state.icao24}/track`);
    const waypoints = data.path || [];

    if (waypoints.length < 2) {
      throw new Error("Insufficient trajectory information.");
    }

    drawHistoricalTrack(waypoints);
    await loadRouteData(false, true);

    showMessage(
      `Historical trajectory loaded (${data.total_waypoints ?? waypoints.length} waypoints).`,
      "success",
    );
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    el.historyButton.disabled = false;
  }
}

async function exportReport() {
  if (!state.icao24) {
    showMessage("Track an aircraft first.", "error");
    return;
  }

  const type = el.reportType.value;
  const format = el.reportFormat.value;
  el.exportReportButton.disabled = true;

  try {
    const response = await fetch(
      `${API_BASE}/flight/${encodeURIComponent(state.icao24)}/reports/${type}?format=${format}`
    );

    if (!response.ok) {
      let detail = `Export failed (${response.status}).`;
      try {
        const error = await response.json();
        detail = error.detail || detail;
      } catch {
        /* keep the HTTP status message */
      }
      throw new Error(detail);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const disposition = response.headers.get("content-disposition") || "";
    const match = disposition.match(/filename\*?=(?:UTF-8''|utf-8'')?([^;]+)/i);
    const filename = match
      ? match[1].replace(/^"|"$/g, "")
      : `skytrack_${state.icao24}_${type}.${format}`;

    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);

    el.reportsMessage.textContent = `Exported ${type} report as ${format.toUpperCase()}.`;
    showMessage(`${type} report exported as ${format.toUpperCase()}.`, "success");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    el.exportReportButton.disabled = false;
  }
}