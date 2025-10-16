const mapElement = document.getElementById('map');
const routeList = document.getElementById('route-list');
const countEl = document.getElementById('count');
const distanceEl = document.getElementById('distance');
const completedEl = document.getElementById('completed-count');
const remainingEl = document.getElementById('remaining-count');
const locateButton = document.getElementById('locate-button');
const distanceFilterToggle = document.getElementById('distance-filter-toggle');
const distanceFilterInput = document.getElementById('distance-filter-input');
const helpToggle = document.getElementById('help-toggle');
const infoOverlay = document.getElementById('info-overlay');
const infoClose = document.getElementById('info-close');
const infoBackdrop = document.getElementById('info-backdrop');
const notesToggle = document.getElementById('notes-toggle');
const notesOverlay = document.getElementById('notes-overlay');
const notesClose = document.getElementById('notes-close');
const notesBackdrop = document.getElementById('notes-backdrop');
const notesField = document.getElementById('notes-field');
const nextStopName = document.getElementById('next-stop-name');
const nextStopAddress = document.getElementById('next-stop-address');

const MOSCOW_CENTER = [55.751244, 37.618423];
const TWO_OPT_THRESHOLD = 160; // avoid heavy optimisation for huge datasets

let map;
let markers = [];
let markerMap = new Map();
let clusterGroup;
let startMarker;
let routeLine;
let currentStart = null;
let currentRoute = [];
let surfPoints = [];

const completedPoints = new Set();
let distanceFilterEnabled = true;
let maxStepKm = 2;
let preferredStartCoords = null;
const notesKey = 'surf-notes';
let lastRouteLimitRelaxed = false;

function pointKey(point) {
    return `${point.name}|${point.address}|${point.coords[0]}|${point.coords[1]}`;
}

function showStatus(message) {
    routeList.innerHTML = '';
    const li = document.createElement('li');
    li.textContent = message;
    routeList.appendChild(li);
}

async function loadSurfPoints() {
    const sources = ['surf.csv', 'surf_coffees_moscow.csv'];
    let csvText = null;
    let lastError = null;

    for (const source of sources) {
        try {
            const response = await fetch(source, { cache: 'no-cache' });
            if (!response.ok) {
                lastError = new Error(`HTTP ${response.status} (${source})`);
                continue;
            }

            const text = await response.text();
            if (text?.trim()) {
                csvText = text;
                if (console?.info) {
                    console.info(`Loaded coffee locations from ${source}`);
                }
                break;
            }
        } catch (error) {
            lastError = error;
        }
    }

    if (!csvText) {
        console.error(lastError ?? 'Unknown CSV load error');
        locateButton.disabled = false;
        locateButton.textContent = 'Определить моё местоположение';
        showStatus('Не удалось загрузить точки Surf Coffee. Убедись, что рядом лежит surf.csv или surf_coffees_moscow.csv и страница открыта через локальный сервер.');
        return;
    }

    try {
        const parsed = parseCsv(csvText);
        const header = parsed.shift() || [];
        const colIndex = Object.fromEntries(
            header.map((key, idx) => [key.trim(), idx])
        );

        const dedup = new Map();
        parsed.forEach((row) => {
            const lat = safeCell(row, colIndex['latitude']);
            const lon = safeCell(row, colIndex['longitude']);
            const name = cleanText(safeCell(row, colIndex['org_name']));
            const address = cleanText(safeCell(row, colIndex['full_address']));

            if (!lat || !lon || !name) return;

            const latValue = Number.parseFloat(lat);
            const lonValue = Number.parseFloat(lon);
            if (Number.isNaN(latValue) || Number.isNaN(lonValue)) return;

            const key = `${latValue.toFixed(5)}|${lonValue.toFixed(5)}`;
            const candidate = {
                name,
                address: address || 'Москва',
                coords: [Number(latValue.toFixed(6)), Number(lonValue.toFixed(6))],
            };

            if (!dedup.has(key)) {
                dedup.set(key, candidate);
                return;
            }

            const existing = dedup.get(key);
            if (shouldReplace(existing, candidate)) {
                dedup.set(key, candidate);
            }
        });

        const uniquePoints = Array.from(dedup.values());
        surfPoints = filterClosePoints(uniquePoints, 50);

        if (!surfPoints.length) {
            throw new Error('no-points');
        }

        initialiseApp();
    } catch (error) {
        console.error(error);
        locateButton.disabled = false;
        locateButton.textContent = 'Определить моё местоположение';
        showStatus('Не удалось обработать CSV с кофейнями. Проверь формат файлов surf.csv / surf_coffees_moscow.csv.');
    }
}

function parseCsv(text) {
    const rows = [];
    let current = [];
    let value = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];

        if (inQuotes) {
            if (char === '"') {
                if (text[i + 1] === '"') {
                    value += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                value += char;
            }
        } else if (char === '"') {
            inQuotes = true;
        } else if (char === ',') {
            current.push(value);
            value = '';
        } else if (char === '\n') {
            current.push(value);
            value = '';
            rows.push(current);
            current = [];
        } else if (char === '\r') {
            // ignore
        } else {
            value += char;
        }
    }

    if (value.length || current.length) {
        current.push(value);
        rows.push(current);
    }

    return rows;
}

function cleanText(value) {
    return (value || '')
        .replace(/[\u202a\u202c\u200f\u200e]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function safeCell(row, index) {
    if (index === undefined || index === null) return '';
    return row[index] ?? '';
}

function entryScore(entry) {
    const name = entry.name || '';
    const address = entry.address || '';
    let score = 0;

    score += Math.min(name.length, 80);
    score += Math.min(address.length * 0.5, 60);

    if (/[×x]/i.test(name)) score += 15;
    if (!/surf coffee$/i.test(name.trim())) score += 10;
    if (address.toLowerCase().includes('москва')) score += 3;

    return score;
}

function shouldReplace(existing, candidate) {
    return entryScore(candidate) > entryScore(existing);
}

function filterClosePoints(points, thresholdMeters) {
    const threshold = thresholdMeters ?? 50;
    const result = [];

    points.forEach((candidate) => {
        let bestIndex = -1;
        let bestDistance = Infinity;

        for (let i = 0; i < result.length; i += 1) {
            const existing = result[i];
            const distance = haversineMeters(existing.coords, candidate.coords);
            if (distance < threshold && distance < bestDistance) {
                bestDistance = distance;
                bestIndex = i;
            }
        }

        if (bestIndex === -1) {
            result.push(candidate);
        } else if (shouldReplace(result[bestIndex], candidate)) {
            result[bestIndex] = candidate;
        }
    });

    return result;
}

function findPreferredStart() {
    const match = surfPoints.find((point) => /secret\s*spot/i.test(point.name));
    return match ? match.coords : null;
}

function haversineMeters([lat1, lon1], [lat2, lon2]) {
    const R = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) *
            Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function initialiseApp() {
    locateButton.disabled = false;
    locateButton.textContent = 'Определить моё местоположение';
    countEl.textContent = String(surfPoints.length);
    completedEl.textContent = '0';
    remainingEl.textContent = String(surfPoints.length);
    distanceEl.textContent = '0 км';
    showStatus('Кликни по карте или используй геолокацию, чтобы выбрать старт.');

    completedPoints.clear();
    markerMap = new Map();
    markers = [];
    clusterGroup = null;
    startMarker = null;
    routeLine = null;
    currentStart = null;
    currentRoute = [];
    lastRouteLimitRelaxed = false;

    preferredStartCoords = findPreferredStart();

    setupFilterControls();
    setupHelpOverlay();
    setupNotes();
    updateNextStop(null, []);
    initMap();
}

function setupFilterControls() {
    if (distanceFilterInput) {
        const initial = Number.parseFloat(distanceFilterInput.value);
        if (Number.isFinite(initial) && initial > 0) {
            maxStepKm = initial;
        } else {
            distanceFilterInput.value = String(maxStepKm);
        }

        const handleInputChange = () => {
            const value = Number.parseFloat(distanceFilterInput.value);
            if (!Number.isFinite(value) || value <= 0) {
                distanceFilterInput.value = String(maxStepKm);
                return;
            }
            maxStepKm = Math.max(0.5, Math.min(25, value));
            distanceFilterInput.value = String(maxStepKm);
            reapplyRoute();
        };

        distanceFilterInput.addEventListener('change', handleInputChange);
        distanceFilterInput.addEventListener('blur', handleInputChange);
    }

    if (distanceFilterToggle) {
        distanceFilterToggle.checked = true;
        distanceFilterEnabled = true;
        distanceFilterToggle.addEventListener('change', () => {
            distanceFilterEnabled = distanceFilterToggle.checked;
            reapplyRoute();
            updateRangeState();
        });
    }

    updateRangeState();
}

function reapplyRoute() {
    if (!currentStart) return;
    setStartPoint(currentStart);
}

function updateRangeState() {
    if (!distanceFilterInput) return;
    distanceFilterInput.disabled = !distanceFilterEnabled;
}

function setupNotes() {
    if (!notesField) return;

    const storageAvailable = typeof localStorage !== 'undefined';

    if (storageAvailable) {
        try {
            const saved = localStorage.getItem(notesKey);
            if (saved) {
                notesField.value = saved;
            }
        } catch {
            // ignore storage errors
        }
    }

    const open = () => {
        if (!notesOverlay) return;
        notesOverlay.classList.add('active');
        notesOverlay.setAttribute('aria-hidden', 'false');
        setTimeout(() => {
            try {
                notesField.focus();
                if (notesField.setSelectionRange) {
                    const len = notesField.value.length;
                    notesField.setSelectionRange(len, len);
                }
            } catch {
                // ignore focus errors
            }
        }, 50);
    };

    const close = () => {
        if (!notesOverlay) return;
        notesOverlay.classList.remove('active');
        notesOverlay.setAttribute('aria-hidden', 'true');
        try {
            notesField.blur();
        } catch {
            // ignore
        }
    };

    notesToggle?.addEventListener('click', () => {
        if (!notesOverlay) return;
        if (notesOverlay.classList.contains('active')) {
            close();
        } else {
            open();
        }
    });

    notesClose?.addEventListener('click', close);
    notesBackdrop?.addEventListener('click', close);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && notesOverlay?.classList.contains('active')) {
            close();
        }
    });

    const persist = () => {
        if (!storageAvailable) return;
        try {
            localStorage.setItem(notesKey, notesField.value);
        } catch {
            // ignore
        }
    };

    notesField.addEventListener('input', persist);
}

function setupHelpOverlay() {
    if (!infoOverlay || !helpToggle) return;

    const open = () => {
        infoOverlay.classList.add('active');
        infoOverlay.setAttribute('aria-hidden', 'false');
    };

    const close = () => {
        infoOverlay.classList.remove('active');
        infoOverlay.setAttribute('aria-hidden', 'true');
    };

    helpToggle.addEventListener('click', () => {
        if (infoOverlay.classList.contains('active')) {
            close();
        } else {
            open();
        }
    });

    infoClose?.addEventListener('click', close);
    infoBackdrop?.addEventListener('click', close);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && infoOverlay.classList.contains('active')) {
            close();
        }
    });
}

function initMap() {
    if (map) return;

    map = L.map(mapElement, {
        zoomControl: false,
        attributionControl: false,
    }).setView(MOSCOW_CENTER, 11.5);

    L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
        {
            maxZoom: 19,
            attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        }
    ).addTo(map);

    L.control
        .zoom({
            position: 'topright',
        })
        .addTo(map);

    clusterGroup = L.markerClusterGroup({
        showCoverageOnHover: false,
        maxClusterRadius: 70,
        spiderfyOnMaxZoom: true,
    });
    map.addLayer(clusterGroup);

    markers = surfPoints.map((point) => {
        const marker = createMarker(point, false);
        markerMap.set(pointKey(point), marker);
        return marker;
    });

    if (clusterGroup.getLayers().length) {
        const bounds = clusterGroup.getBounds();
        if (bounds.isValid()) {
            map.fitBounds(bounds.pad(0.08));
        }
    }

    if (surfPoints.length) {
        if (preferredStartCoords) {
            setStartPoint(preferredStartCoords);
        } else {
            const randomPoint =
                surfPoints[Math.floor(Math.random() * surfPoints.length)];
            setStartPoint(randomPoint.coords);
        }
    }

    map.on('click', (event) => {
        const { lat, lng } = event.latlng;
        setStartPoint([lat, lng]);
    });
}

function createMarker(point, completed) {
    const icon = L.divIcon({
        className: '',
        html: `<span class="coffee-marker${completed ? ' coffee-marker--visited' : ''}" aria-hidden="true">☕️</span>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
    });

    const marker = L.marker(point.coords, { icon });
    if (clusterGroup) {
        clusterGroup.addLayer(marker);
    } else {
        marker.addTo(map);
    }

    marker.on('click', () => {
        const key = pointKey(point);
        if (completedPoints.has(key)) {
            completedPoints.delete(key);
            updateMarkerState(point, false);
        } else {
            completedPoints.add(key);
            updateMarkerState(point, true);
        }

        if (currentRoute.length) {
            updateRouteList(currentRoute);
        } else {
            const adHocRoute = surfPoints.map((p, index) => ({ ...p, index }));
            updateRouteList(adHocRoute);
        }
    });

    marker.bindPopup(
        `<strong>${point.name}</strong><br>${point.address}`
    );

    return marker;
}

function updateMarkerState(point, completed) {
    const key = pointKey(point);
    const existing = markerMap.get(key);
    if (!existing) return;

    existing.setIcon(
        L.divIcon({
            className: '',
            html: `<span class="coffee-marker${completed ? ' coffee-marker--visited' : ''}" aria-hidden="true">☕️</span>`,
            iconSize: [32, 32],
            iconAnchor: [16, 16],
        })
    );

    clusterGroup?.refreshClusters(existing);
}

function setStartPoint(coords) {
    if (!surfPoints.length) return;

    currentStart = coords;

    if (!startMarker) {
        startMarker = L.marker(coords, {
            draggable: false,
            icon: L.icon({
                iconUrl:
                    'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
                shadowUrl:
                    'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
                iconAnchor: [12, 41],
                popupAnchor: [1, -34],
            }),
        }).addTo(map);
    } else {
        startMarker.setLatLng(coords);
    }

    startMarker.bindPopup('Старт маршрута').openPopup();

    const bestRoute = computeRoute(coords);
    currentRoute = bestRoute;

    const routeKeys = new Set(bestRoute.map((point) => pointKey(point)));
    Array.from(completedPoints).forEach((key) => {
        if (!routeKeys.has(key)) {
            completedPoints.delete(key);
            const pointToReset = surfPoints.find((p) => pointKey(p) === key);
            if (pointToReset) {
                updateMarkerState(pointToReset, false);
            }
        }
    });

    drawRoute(coords, bestRoute);
    updateRouteList(bestRoute);
}

function computeRoute(startCoords) {
    const points = surfPoints.map((point, index) => ({
        ...point,
        index,
    }));

    if (!points.length) return [];

    const buildRoute = (limitKm) => {
        const remaining = new Set(points.map((p) => p.index));
        const route = [];
        let current = { coords: startCoords };

        while (remaining.size) {
            let bestPoint = null;
            let bestDist = Infinity;

            remaining.forEach((idx) => {
                const point = points[idx];
                const dist = haversine(current.coords, point.coords);
                if (dist <= limitKm && dist < bestDist) {
                    bestDist = dist;
                    bestPoint = point;
                }
            });

            if (!bestPoint) break;
            route.push(bestPoint);
            remaining.delete(bestPoint.index);
            current = bestPoint;
        }

        return route;
    };

    const stepLimit = distanceFilterEnabled ? maxStepKm : Infinity;
    let route = buildRoute(stepLimit);
    lastRouteLimitRelaxed = false;

    if (!route.length && distanceFilterEnabled) {
        route = buildRoute(Infinity);
        lastRouteLimitRelaxed = true;
    }

    if (route.length <= TWO_OPT_THRESHOLD) {
        return twoOpt(route, startCoords);
    }

    return route;
}

function haversine([lat1, lon1], [lat2, lon2]) {
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) *
            Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function toRad(degrees) {
    return (degrees * Math.PI) / 180;
}

function routeDistance(route, startCoords) {
    if (!route.length) return 0;
    let distance = haversine(startCoords, route[0].coords);
    for (let i = 0; i < route.length - 1; i += 1) {
        distance += haversine(route[i].coords, route[i + 1].coords);
    }
    return distance;
}

function twoOpt(route, startCoords) {
    if (route.length < 3) return route;

    let improved = true;
    let bestRoute = [...route];

    while (improved) {
        improved = false;

        for (let i = 0; i < bestRoute.length - 2; i += 1) {
            for (let k = i + 2; k < bestRoute.length; k += 1) {
                const newRoute = twoOptSwap(bestRoute, i, k);

                const currentDistance = routeDistance(bestRoute, startCoords);
                const newDistance = routeDistance(newRoute, startCoords);

                if (newDistance + 0.001 < currentDistance) {
                    bestRoute = newRoute;
                    improved = true;
                }
            }
        }
    }

    return bestRoute;
}

function twoOptSwap(route, i, k) {
    const newRoute = route.slice(0, i + 1);
    const reversedSegment = route.slice(i + 1, k + 1).reverse();
    const tail = route.slice(k + 1);
    return newRoute.concat(reversedSegment, tail);
}

function drawRoute(startCoords, route) {
    if (routeLine) {
        routeLine.remove();
        routeLine = null;
    }

    if (!route.length) return;

    const latlngs = [startCoords, ...route.map((point) => point.coords)];

    routeLine = L.polyline(latlngs, {
        color: '#7c6cff',
        weight: 5,
        opacity: 0.9,
        dashArray: '18 12',
        lineCap: 'round',
    }).addTo(map);

    const bounds = L.latLngBounds(latlngs);
    map.fitBounds(bounds.pad(0.08));
}

function updateRouteList(route) {
    routeList.innerHTML = '';
    countEl.textContent = String(route.length);

    if (!route.length) {
        showStatus('Пока нет маршрута — выбери стартовую точку.');
        remainingEl.textContent = '0';
        distanceEl.textContent = '0 км';
        completedEl.textContent = '0';
        updateNextStop(null, route);
        return;
    }

    const distance = routeDistance(route, currentStart);
    distanceEl.textContent = `${distance.toFixed(1)} км`;

    const decorated = route.map((point, index) => ({ point, index }));
    const pending = decorated.filter(({ point }) => !completedPoints.has(pointKey(point)));
    const done = decorated.filter(({ point }) => completedPoints.has(pointKey(point)));
    const ordered = [...pending, ...done];
    const nextPoint = pending.length ? pending[0].point : null;

    ordered.forEach(({ point, index }) => {
        const key = pointKey(point);
        const li = document.createElement('li');
        li.dataset.key = key;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `route-${index}`;
        checkbox.checked = completedPoints.has(key);

        const label = document.createElement('label');
        label.setAttribute('for', checkbox.id);
        label.innerHTML = `<strong>${index + 1}. ${point.name}</strong><span>${point.address}</span>`;

        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                completedPoints.add(key);
            } else {
                completedPoints.delete(key);
            }
            updateMarkerState(point, checkbox.checked);
            updateRouteList(route);
        });

        if (checkbox.checked) {
            li.classList.add('completed');
        }
        updateMarkerState(point, checkbox.checked);

        li.appendChild(checkbox);
        li.appendChild(label);
        routeList.appendChild(li);
    });

    updateProgress(route);
    updateNextStop(nextPoint, route);
}

function updateProgress(route) {
    const total = route.length;
    if (!total) {
        completedEl.textContent = '0';
        remainingEl.textContent = '0';
        return;
    }

    const completed = route.reduce((acc, point) => {
        return acc + (completedPoints.has(pointKey(point)) ? 1 : 0);
    }, 0);

    completedEl.textContent = String(completed);
    remainingEl.textContent = String(total - completed);
}

function updateNextStop(nextPoint, route) {
    if (!nextStopName || !nextStopAddress) return;

    if (nextPoint) {
        nextStopName.textContent = nextPoint.name;
        nextStopAddress.textContent = nextPoint.address;
        return;
    }

    const total = route?.length ?? 0;
    const completedInRoute = total
        ? route.reduce((acc, point) => acc + (completedPoints.has(pointKey(point)) ? 1 : 0), 0)
        : 0;

    if (total === 0) {
        nextStopName.textContent = '—';
        nextStopAddress.textContent = 'Сначала выбери стартовую точку.';
    } else if (completedInRoute >= total) {
        nextStopName.textContent = 'Все кофейни пройдены!';
        nextStopAddress.textContent = 'Можно отправляться праздновать ☕️';
    } else if (distanceFilterEnabled && lastRouteLimitRelaxed) {
        nextStopName.textContent = '—';
        nextStopAddress.textContent = 'Маршрут ограничен по дистанции. Увеличь лимит, чтобы увидеть следующую кофейню.';
    } else {
        nextStopName.textContent = '—';
        nextStopAddress.textContent = 'Отметь пройденные кофейни, чтобы увидеть следующую.';
    }
}

function locateUser() {
    if (!navigator.geolocation) {
        alert('Геолокация недоступна в этом браузере.');
        return;
    }

    ensureMapInitialized();

    locateButton.disabled = true;
    locateButton.textContent = 'Определяем...';

    navigator.geolocation.getCurrentPosition(
        (position) => {
            locateButton.disabled = false;
            locateButton.textContent = 'Определить моё местоположение';

            const coords = [
                position.coords.latitude,
                position.coords.longitude,
            ];
            setStartPoint(coords);
        },
        () => {
            locateButton.disabled = false;
            locateButton.textContent = 'Определить моё местоположение';
            alert('Не удалось получить координаты. Попробуй выбрать точку на карте.');
        },
        {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 30000,
        }
    );
}

locateButton.addEventListener('click', locateUser);

countEl.textContent = '0';
distanceEl.textContent = '0 км';
completedEl.textContent = '0';
remainingEl.textContent = '0';
locateButton.disabled = true;
locateButton.textContent = 'Загружаем точки...';
showStatus('Загружаем адреса Surf Coffee...');

loadSurfPoints();
