(function () {
  const CITIES = [
    {
      name: "New York, NY",
      lat: 40.7580, lng: -73.9855,
      heading: "New York, NY, USA",
      address: "Times Square, Manhattan, New York, NY 10036, USA",
      offset: "-04:00",
    },
    {
      name: "London, UK",
      lat: 51.5074, lng: -0.1278,
      heading: "London, England, UK",
      address: "Trafalgar Square, London, WC2N 5DN, UK",
      offset: "+01:00",
    },
    {
      name: "Paris, France",
      lat: 48.8566, lng: 2.3522,
      heading: "Paris, Île-de-France, France",
      address: "Champ de Mars, 75007 Paris, France",
      offset: "+02:00",
    },
    {
      name: "Tokyo, Japan",
      lat: 35.6895, lng: 139.6917,
      heading: "Tokyo, Japan",
      address: "Shibuya Crossing, Shibuya City, Tokyo 150-0002, Japan",
      offset: "+09:00",
    },
    {
      name: "Dubai, UAE",
      lat: 25.2048, lng: 55.2708,
      heading: "Dubai, United Arab Emirates",
      address: "Downtown Dubai, Dubai, UAE",
      offset: "+04:00",
    },
    {
      name: "Sydney, Australia",
      lat: -33.8688, lng: 151.2093,
      heading: "Sydney, NSW, Australia",
      address: "Circular Quay, Sydney NSW 2000, Australia",
      offset: "+10:00",
    },
    {
      name: "Reykjavik, Iceland",
      lat: 64.1466, lng: -21.9426,
      heading: "Reykjavík, Iceland",
      address: "Laugavegur, 101 Reykjavík, Iceland",
      offset: "+00:00",
    },
    {
      name: "Rio de Janeiro, Brazil",
      lat: -22.9068, lng: -43.1729,
      heading: "Rio de Janeiro, Brazil",
      address: "Copacabana, Rio de Janeiro - RJ, 22070-010, Brazil",
      offset: "-03:00",
    },
    {
      name: "Bali, Indonesia",
      lat: -8.4095, lng: 115.1889,
      heading: "Kuta, Bali, Indonesia",
      address: "Kuta, Badung Regency, Bali 80361, Indonesia",
      offset: "+08:00",
    },
    { name: "Custom location…", lat: null, lng: null, heading: "", address: "", offset: "+00:00", custom: true },
  ];

  const $ = (id) => document.getElementById(id);
  const drop = $("drop"), fileInput = $("file"), preview = $("preview"), dropLabel = $("dropLabel");
  const citySel = $("city"), latIn = $("lat"), lngIn = $("lng");
  const addStampChk = $("addStamp"), stampFields = $("stampFields");
  const headingIn = $("heading"), addressIn = $("address"), gmtOffsetIn = $("gmtOffset"), timestampIn = $("timestamp");
  const makeIn = $("make"), modelIn = $("model");
  const submitBtn = $("submit"), inspectBtn = $("inspectBtn"), status = $("status");
  const resultImg = $("resultImg"), resultEmpty = $("resultEmpty"), metaResult = $("metaResult");

  let selectedFile = null;

  CITIES.forEach((c, i) => {
    const o = document.createElement("option");
    o.value = i;
    o.textContent = c.name;
    citySel.appendChild(o);
  });

  const coordReadout = $("coordReadout");
  const searchBox = $("searchBox"), searchBtn = $("searchBtn");
  const gmapsLink = $("gmapsLink");

  function applyPreset(c) {
    latIn.value = c.lat != null ? c.lat.toFixed(6) : "";
    lngIn.value = c.lng != null ? c.lng.toFixed(6) : "";
    headingIn.value = c.heading || "";
    addressIn.value = c.address || "";
    gmtOffsetIn.value = c.offset || "+00:00";
    if (c.lat != null) setPin(c.lat, c.lng, { keepSelection: true, flyTo: true });
  }

  citySel.addEventListener("change", () => applyPreset(CITIES[+citySel.value]));

  // --- Leaflet map: drag/click/search to pinpoint a fake location ---------
  const map = L.map("leafletMap", { worldCopyJump: true }).setView([20, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  const marker = L.marker([20, 0], { draggable: true }).addTo(map);

  function setPin(lat, lng, opts) {
    opts = opts || {};
    latIn.value = lat.toFixed(6);
    lngIn.value = lng.toFixed(6);
    marker.setLatLng([lat, lng]);
    if (opts.flyTo) map.setView([lat, lng], Math.max(map.getZoom(), 11));
    if (!opts.keepSelection) citySel.value = CITIES.length - 1; // switch to "Custom location…"
    if (!opts.silent) coordReadout.innerHTML = `Pinned: <b>${lat.toFixed(6)}°, ${lng.toFixed(6)}°</b>`;
    gmapsLink.href = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
    gmapsLink.style.display = "inline-block";
  }

  async function reverseGeocode(lat, lng) {
    coordReadout.textContent = "Looking up address…";
    try {
      const res = await fetch(`/api/reverse?lat=${lat}&lon=${lng}`);
      const data = await res.json();
      if (data.display_name) {
        const a = data.address || {};
        headingIn.value = [a.city || a.town || a.village || a.county, a.state, a.country].filter(Boolean).join(", ");
        addressIn.value = data.display_name;
        coordReadout.innerHTML = `Pinned: <b>${lat.toFixed(6)}°, ${lng.toFixed(6)}°</b><br>${data.display_name}`;
      } else {
        coordReadout.innerHTML = `Pinned: <b>${lat.toFixed(6)}°, ${lng.toFixed(6)}°</b> (no address found here)`;
      }
    } catch (e) {
      coordReadout.innerHTML = `Pinned: <b>${lat.toFixed(6)}°, ${lng.toFixed(6)}°</b> (address lookup failed)`;
    }
  }

  map.on("click", (e) => {
    setPin(e.latlng.lat, e.latlng.lng, { silent: true });
    reverseGeocode(e.latlng.lat, e.latlng.lng);
  });
  marker.on("dragend", () => {
    const { lat, lng } = marker.getLatLng();
    setPin(lat, lng, { silent: true });
    reverseGeocode(lat, lng);
  });

  // Pulls lat/lng out of a Google Maps URL: place URLs encode the precise pin
  // as !3d<lat>!4d<lng>, plain map URLs use @lat,lng, and share links use q=/query=.
  function extractLatLngFromUrl(url) {
    let m = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
    m = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
    m = url.match(/[?&](?:q|query)=(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
    return null;
  }

  async function searchByMapsLink(raw) {
    coordReadout.textContent = "Reading that Google Maps link…";
    searchBtn.disabled = true;
    try {
      let coords = extractLatLngFromUrl(raw);
      if (!coords) {
        // Shortened link (goo.gl/maps.app.goo.gl) — ask the server to follow the redirect.
        const res = await fetch(`/api/resolve-link?url=${encodeURIComponent(raw)}`);
        const data = await res.json();
        if (data.url) coords = extractLatLngFromUrl(data.url);
      }
      if (!coords) {
        coordReadout.textContent = "Couldn't find coordinates in that link.";
        return;
      }
      setPin(coords.lat, coords.lng, { flyTo: true, silent: true });
      map.setView([coords.lat, coords.lng], 16);
      citySel.value = CITIES.length - 1;
      await reverseGeocode(coords.lat, coords.lng);
    } catch (e) {
      coordReadout.textContent = "Couldn't resolve that link — check your connection and try again.";
    } finally {
      searchBtn.disabled = false;
    }
  }

  async function doSearch() {
    const q = searchBox.value.trim();
    if (!q) return;
    if (/^https?:\/\//i.test(q)) return searchByMapsLink(q);

    coordReadout.textContent = "Searching…";
    searchBtn.disabled = true;
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const results = await res.json();
      if (!results.length) {
        coordReadout.textContent = `No results for "${q}".`;
        return;
      }
      const r = results[0];
      const lat = parseFloat(r.lat), lng = parseFloat(r.lon);
      setPin(lat, lng, { flyTo: true, silent: true });
      map.setView([lat, lng], 14);
      headingIn.value = r.display_name.split(",").slice(0, 3).join(",").trim();
      addressIn.value = r.display_name;
      citySel.value = CITIES.length - 1;
      coordReadout.innerHTML = `Found: <b>${r.display_name}</b>`;
    } catch (e) {
      coordReadout.textContent = "Search failed — check your connection and try again.";
    } finally {
      searchBtn.disabled = false;
    }
  }
  searchBtn.addEventListener("click", doSearch);
  searchBox.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doSearch();
    }
  });

  [latIn, lngIn].forEach((el) =>
    el.addEventListener("change", () => {
      const lat = parseFloat(latIn.value), lng = parseFloat(lngIn.value);
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) setPin(lat, lng, { flyTo: true });
    })
  );

  applyPreset(CITIES[0]);

  addStampChk.addEventListener("change", () => {
    stampFields.style.display = addStampChk.checked ? "block" : "none";
  });

  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  function handleFile(file) {
    if (!/\.jpe?g$/i.test(file.name) && file.type !== "image/jpeg") {
      setStatus("Only JPEG photos are supported (GPS EXIF needs a JPEG container).", "err");
      return;
    }
    selectedFile = file;
    preview.src = URL.createObjectURL(file);
    preview.style.display = "block";
    dropLabel.innerHTML = "<b>" + file.name + "</b> — click to change";
    submitBtn.disabled = false;
    inspectBtn.disabled = false;
    setStatus("", "");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderMetadata(data) {
    resultImg.style.display = "none";
    resultEmpty.style.display = "none";
    metaResult.style.display = "block";

    const f = data.file || {};
    const sizeKb = f.sizeBytes != null ? (f.sizeBytes / 1024).toFixed(1) + " KB" : "?";
    const dims = f.width && f.height ? `${f.width}×${f.height}px` : "unknown dimensions";

    let gpsHtml = '<div class="gps-line meta-none">No GPS data found in this photo.</div>';
    if (data.gps) {
      const { lat, lon } = data.gps;
      gpsHtml = `<div class="gps-line">📍 GPS: <b>${lat}°, ${lon}°</b>
        <a href="https://www.google.com/maps/search/?api=1&query=${lat},${lon}" target="_blank" rel="noopener noreferrer">Open in Google Maps ↗</a></div>`;
    }

    const sectionOrder = ["Image", "Camera / Exif", "GPS", "Thumbnail", "Interop"];
    const sections = data.exif || {};
    const sectionsHtml = sectionOrder
      .filter((name) => sections[name] && Object.keys(sections[name]).length)
      .map((name) => {
        const rows = Object.entries(sections[name])
          .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
          .join("");
        return `<div class="meta-section"><h4>${escapeHtml(name)}</h4><div class="meta-table-wrap"><table class="meta-table">${rows}</table></div></div>`;
      })
      .join("");

    metaResult.innerHTML = `
      <div class="meta-summary">
        <div class="file-name">${escapeHtml(f.name || "photo")}</div>
        <div>${escapeHtml(f.format ? f.format.toUpperCase() : "?")} · ${dims} · ${sizeKb}</div>
        ${gpsHtml}
      </div>
      ${sectionsHtml || '<p class="meta-none">No EXIF metadata found (likely a re-saved, screenshotted, or stripped image).</p>'}
    `;
  }

  function setStatus(msg, cls) {
    status.textContent = msg;
    status.className = "status" + (cls ? " " + cls : "");
  }

  submitBtn.addEventListener("click", async () => {
    if (!selectedFile) return;
    const lat = parseFloat(latIn.value);
    const lng = parseFloat(lngIn.value);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      setStatus("Enter valid latitude/longitude.", "err");
      return;
    }

    const form = new FormData();
    form.append("photo", selectedFile);
    form.append("lat", lat);
    form.append("lng", lng);
    if (timestampIn.value.trim()) form.append("timestamp", timestampIn.value.trim());
    if (makeIn.value.trim()) form.append("make", makeIn.value.trim());
    if (modelIn.value.trim()) form.append("model", modelIn.value.trim());
    form.append("addStamp", addStampChk.checked ? "true" : "false");
    if (addStampChk.checked) {
      form.append("heading", headingIn.value.trim());
      form.append("address", addressIn.value.trim());
      form.append("gmtOffset", gmtOffsetIn.value.trim() || "+00:00");
    }

    submitBtn.disabled = true;
    setStatus("Writing geotag…", "");

    try {
      const res = await fetch("/api/geotag", { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Request failed.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      metaResult.style.display = "none";
      resultImg.src = url;
      resultImg.style.display = "block";
      resultEmpty.style.display = "none";

      const a = document.createElement("a");
      a.href = url;
      a.download = selectedFile.name.replace(/\.jpe?g$/i, "") + "-geotagged.jpg";
      a.click();
      setStatus(`Done — geotagged to ${lat.toFixed(4)}, ${lng.toFixed(4)} and downloaded.`, "ok");
    } catch (e) {
      setStatus(e.message, "err");
    } finally {
      submitBtn.disabled = false;
    }
  });

  inspectBtn.addEventListener("click", async () => {
    if (!selectedFile) return;
    const form = new FormData();
    form.append("photo", selectedFile);

    inspectBtn.disabled = true;
    setStatus("Reading metadata…", "");

    try {
      const res = await fetch("/api/inspect", { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Request failed.");
      }
      const data = await res.json();
      renderMetadata(data);
      setStatus(data.gps ? "Metadata extracted — this photo has GPS data." : "Metadata extracted — no GPS found.", "ok");
    } catch (e) {
      setStatus(e.message, "err");
    } finally {
      inspectBtn.disabled = false;
    }
  });
})();
