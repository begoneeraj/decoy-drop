const express = require("express");
const multer = require("multer");
const piexif = require("piexifjs");
const sharp = require("sharp");
const path = require("path");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.use(express.static(path.join(__dirname, "public")));
app.use("/vendor/leaflet", express.static(path.join(__dirname, "node_modules/leaflet/dist")));

const NOMINATIM_HEADERS = { "User-Agent": "DecoyDrop-local-prank-tool/1.0" };

// Proxies to OpenStreetMap's Nominatim so the browser doesn't call it directly
// (keeps a proper User-Agent per their usage policy, and centralizes the one
// external dependency this app has: place search + reverse geocoding).
app.get("/api/geocode", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json([]);
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: NOMINATIM_HEADERS });
    const data = await r.json();
    res.json(data.map((d) => ({ display_name: d.display_name, lat: d.lat, lon: d.lon })));
  } catch (err) {
    res.status(502).json({ error: "Search lookup failed: " + err.message });
  }
});

app.get("/api/reverse", async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return res.status(400).json({ error: "Bad coordinates." });
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`;
    const r = await fetch(url, { headers: NOMINATIM_HEADERS });
    const data = await r.json();
    res.json({ display_name: data.display_name || "", address: data.address || {} });
  } catch (err) {
    res.status(502).json({ error: "Reverse lookup failed: " + err.message });
  }
});

const MAPS_LINK_HOSTS = new Set([
  "maps.google.com",
  "www.google.com",
  "google.com",
  "goo.gl",
  "maps.app.goo.gl",
]);

// Follows a (possibly shortened) Google Maps link to its final URL, so the
// client can pull the lat/lng out of it. Restricted to known Maps hostnames
// so this can't be used as a general-purpose open redirect fetcher.
app.get("/api/resolve-link", async (req, res) => {
  const raw = req.query.url || "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return res.status(400).json({ error: "Not a valid URL." });
  }
  if (!/^https?:$/.test(parsed.protocol) || !MAPS_LINK_HOSTS.has(parsed.hostname)) {
    return res.status(400).json({ error: "Only Google Maps links are supported." });
  }
  try {
    const r = await fetch(parsed.toString(), {
      redirect: "follow",
      headers: { "User-Agent": "DecoyDrop-local-prank-tool/1.0" },
    });
    res.json({ url: r.url });
  } catch (err) {
    res.status(502).json({ error: "Couldn't resolve that link: " + err.message });
  }
});

function toDMSRational(deg) {
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const minFloat = (abs - d) * 60;
  const m = Math.floor(minFloat);
  const secFloat = (minFloat - m) * 60;
  const s = Math.round(secFloat * 100);
  return [[d, 1], [m, 1], [s, 100]];
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function exifDateTime(dateInput) {
  const d = dateInput ? new Date(dateInput) : new Date();
  return (
    d.getFullYear() + ":" + pad2(d.getMonth() + 1) + ":" + pad2(d.getDate()) +
    " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds())
  );
}

function applyExifGps(jpegBuffer, { lat, lng, altitude, timestamp, make, model }) {
  const jpegBinary = jpegBuffer.toString("binary");

  let exifObj;
  try {
    exifObj = piexif.load(jpegBinary);
  } catch (e) {
    exifObj = { "0th": {}, Exif: {}, GPS: {}, "1st": {}, thumbnail: null };
  }

  const dt = exifDateTime(timestamp);

  exifObj.GPS = {
    [piexif.GPSIFD.GPSVersionID]: [2, 3, 0, 0],
    [piexif.GPSIFD.GPSLatitudeRef]: lat >= 0 ? "N" : "S",
    [piexif.GPSIFD.GPSLatitude]: toDMSRational(lat),
    [piexif.GPSIFD.GPSLongitudeRef]: lng >= 0 ? "E" : "W",
    [piexif.GPSIFD.GPSLongitude]: toDMSRational(lng),
    ...(Number.isFinite(altitude)
      ? {
          [piexif.GPSIFD.GPSAltitudeRef]: altitude < 0 ? 1 : 0,
          [piexif.GPSIFD.GPSAltitude]: [Math.round(Math.abs(altitude) * 100), 100],
        }
      : {}),
    [piexif.GPSIFD.GPSDateStamp]: dt.slice(0, 10),
  };

  exifObj["0th"][piexif.ImageIFD.DateTime] = dt;
  exifObj.Exif[piexif.ExifIFD.DateTimeOriginal] = dt;
  exifObj.Exif[piexif.ExifIFD.DateTimeDigitized] = dt;
  if (make) exifObj["0th"][piexif.ImageIFD.Make] = make;
  if (model) exifObj["0th"][piexif.ImageIFD.Model] = model;

  const exifBytes = piexif.dump(exifObj);
  const newJpegBinary = piexif.insert(exifBytes, jpegBinary);
  return Buffer.from(newJpegBinary, "binary");
}

function escapeXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function stampDateParts(dateInput) {
  const d = dateInput ? new Date(dateInput) : new Date();
  const dayName = DAY_NAMES[d.getDay()];
  const dateStr = pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1) + "/" + d.getFullYear();
  let h = d.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  const timeStr = h + ":" + pad2(d.getMinutes()) + " " + ampm;
  return `${dayName}, ${dateStr} ${timeStr}`;
}

// Rough average glyph-width ratios for Arial at a given font size (empirical, good enough to fit-not-overflow).
const AVG_CHAR_W = { bold: 0.60, normal: 0.53 };

function estimateWidth(text, size, bold) {
  return text.length * size * AVG_CHAR_W[bold ? "bold" : "normal"];
}

function wrapWords(text, size, bold, maxWidth) {
  const maxChars = Math.max(4, Math.floor(maxWidth / (size * AVG_CHAR_W[bold ? "bold" : "normal"])));
  if (text.length <= maxChars) return [text];
  const words = text.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const cand = cur ? cur + " " + w : w;
    if (cand.length <= maxChars) {
      cur = cand;
    } else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Fits `text` inside maxWidth: shrinks font size first, then wraps (up to maxLines),
// then truncates with an ellipsis as a last resort. Never lets a line run past maxWidth.
function fitText(text, size0, minSize, bold, maxWidth, maxLines) {
  if (estimateWidth(text, size0, bold) <= maxWidth) {
    return { size: size0, lines: [text] };
  }
  const singleFitSize = maxWidth / (text.length * AVG_CHAR_W[bold ? "bold" : "normal"]);
  if (singleFitSize >= minSize) {
    return { size: singleFitSize, lines: [text] };
  }
  const size = minSize;
  let lines = wrapWords(text, size, bold, maxWidth);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines - 1);
    let rest = lines.slice(maxLines - 1).join(" ");
    const maxChars = Math.max(4, Math.floor(maxWidth / (size * AVG_CHAR_W[bold ? "bold" : "normal"])));
    if (rest.length > maxChars) rest = rest.slice(0, Math.max(1, maxChars - 1)).trimEnd() + "…";
    kept.push(rest);
    lines = kept;
  }
  return { size, lines };
}

function buildStampSvg({ width, height, heading, address, lat, lng, dateLine, gmtOffset }) {
  // Base scale off the smaller dimension so a narrow/tall screenshot doesn't get
  // an oversized band sized as if it were a wide landscape photo.
  const baseUnit = Math.min(width, height);
  const bandHeight0 = Math.max(70, Math.min(190, baseUnit * 0.16));
  const pad = bandHeight0 * 0.14;
  const mapSize = bandHeight0 - pad * 2;
  const textX = pad + mapSize + pad * 1.2;
  const maxTextWidth = Math.max(40, width - textX - pad);

  const headingSize0 = bandHeight0 * 0.20;
  const lineSize0 = bandHeight0 * 0.135;
  const minHeadingSize = Math.max(11, headingSize0 * 0.55);
  const minLineSize = Math.max(10, lineSize0 * 0.55);

  const latLngText = `Lat: ${lat.toFixed(6)}°  Long: ${lng.toFixed(6)}°`;
  const dateText = `${dateLine} GMT ${gmtOffset}`;

  const fitted = [
    { ...fitText(heading, headingSize0, minHeadingSize, true, maxTextWidth, 2), weight: 700 },
    { ...fitText(address, lineSize0, minLineSize, false, maxTextWidth, 2), weight: 400 },
    { ...fitText(latLngText, lineSize0, minLineSize, false, maxTextWidth, 1), weight: 400 },
    { ...fitText(dateText, lineSize0, minLineSize, false, maxTextWidth, 1), weight: 400 },
  ];

  // Flatten into individual render lines, each carrying its own font size/weight.
  let renderLines = [];
  for (const f of fitted) {
    for (const text of f.lines) renderLines.push({ text, size: f.size, weight: f.weight });
  }

  const topMargin = pad * 0.9;
  const bottomMargin = pad * 0.9;
  let textBlockHeight = topMargin + bottomMargin;
  for (const l of renderLines) textBlockHeight += l.size * 1.32;

  let bandHeight = Math.max(mapSize + pad * 2, textBlockHeight);
  const maxBand = height * 0.42;
  if (bandHeight > maxBand) {
    const scale = maxBand / bandHeight;
    renderLines = renderLines.map((l) => ({ ...l, size: l.size * scale }));
    textBlockHeight = topMargin * scale + bottomMargin * scale;
    for (const l of renderLines) textBlockHeight += l.size * 1.32;
    bandHeight = Math.max(mapSize + pad * 2, Math.min(maxBand, textBlockHeight));
  }

  const mapX = pad;
  const mapY = (bandHeight - mapSize) / 2;

  let ty = (bandHeight - textBlockHeight) / 2 + topMargin + renderLines[0].size * 0.85;
  const textEls = renderLines
    .map((l, i) => {
      const y = i === 0 ? ty : (ty += renderLines[i - 1].size * 1.32);
      return `<text x="${textX}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${l.size.toFixed(1)}" font-weight="${l.weight}" fill="#ffffff">${escapeXml(l.text)}</text>`;
    })
    .join("\n      ");

  return `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="${height - bandHeight}" width="${width}" height="${bandHeight}" fill="#000000" fill-opacity="0.56"/>
  <g transform="translate(0, ${height - bandHeight})">
    <clipPath id="mapclip"><rect x="${mapX}" y="${mapY}" width="${mapSize}" height="${mapSize}" rx="${mapSize * 0.14}"/></clipPath>
    <g clip-path="url(#mapclip)">
      <rect x="${mapX}" y="${mapY}" width="${mapSize}" height="${mapSize}" fill="#d9e2d6"/>
      <rect x="${mapX}" y="${mapY + mapSize * 0.55}" width="${mapSize}" height="${mapSize * 0.2}" fill="#bcd2c4"/>
      <path d="M ${mapX} ${mapY + mapSize * 0.75} Q ${mapX + mapSize * 0.5} ${mapY + mapSize * 0.55} ${mapX + mapSize} ${mapY + mapSize * 0.85}" stroke="#a9c6d8" stroke-width="${mapSize * 0.07}" fill="none"/>
      <line x1="${mapX + mapSize * 0.5}" y1="${mapY}" x2="${mapX + mapSize * 0.42}" y2="${mapY + mapSize}" stroke="#ffffff" stroke-width="${mapSize * 0.04}"/>
      <line x1="${mapX}" y1="${mapY + mapSize * 0.4}" x2="${mapX + mapSize}" y2="${mapY + mapSize * 0.34}" stroke="#ffffff" stroke-width="${mapSize * 0.03}"/>
      <path d="M ${mapX + mapSize * 0.05} ${mapY + mapSize * 0.15} Q ${mapX + mapSize * 0.55} ${mapY + mapSize * 0.4} ${mapX + mapSize * 0.9} ${mapY + mapSize * 0.95}" stroke="#e9b64a" stroke-width="${mapSize * 0.045}" fill="none"/>
    </g>
    <rect x="${mapX}" y="${mapY}" width="${mapSize}" height="${mapSize}" rx="${mapSize * 0.14}" fill="none" stroke="#00000033" stroke-width="1"/>
    <circle cx="${mapX + mapSize / 2}" cy="${mapY + mapSize / 2}" r="${mapSize * 0.1}" fill="#2e8b87" stroke="#0f2e2c" stroke-width="${mapSize * 0.02}"/>
    ${textEls}
  </g>
</svg>`;
}

async function applyVisibleStamp(jpegBuffer, opts) {
  const img = sharp(jpegBuffer).rotate();
  const meta = await img.metadata();
  const width = meta.width;
  const height = meta.height;

  const svg = buildStampSvg({ width, height, ...opts });
  const overlay = Buffer.from(svg);

  return img.composite([{ input: overlay, top: 0, left: 0 }]).jpeg({ quality: 92 }).toBuffer();
}

app.post("/api/geotag", upload.single("photo"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No photo uploaded." });

    const isJpeg = file.mimetype === "image/jpeg" || /\.jpe?g$/i.test(file.originalname);
    if (!isJpeg) {
      return res.status(400).json({
        error: "Only JPEG photos can carry GPS EXIF data. Please upload a .jpg/.jpeg file.",
      });
    }

    const lat = parseFloat(req.body.lat);
    const lng = parseFloat(req.body.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return res.status(400).json({ error: "Latitude/longitude missing or invalid." });
    }
    const altitude = parseFloat(req.body.altitude);
    const make = (req.body.make || "").trim();
    const model = (req.body.model || "").trim();
    const timestamp = req.body.timestamp;
    const addStamp = req.body.addStamp === "true";

    let outBuffer = file.buffer;

    if (addStamp) {
      const heading = (req.body.heading || "").trim() || "Unknown Location";
      const address = (req.body.address || "").trim();
      const gmtOffset = (req.body.gmtOffset || "+00:00").trim();
      outBuffer = await applyVisibleStamp(outBuffer, {
        heading,
        address,
        lat,
        lng,
        dateLine: stampDateParts(timestamp),
        gmtOffset,
      });
    }

    outBuffer = applyExifGps(outBuffer, { lat, lng, altitude, timestamp, make, model });

    const outName = file.originalname.replace(/(\.jpe?g)$/i, "") + "-geotagged.jpg";
    res.set({
      "Content-Type": "image/jpeg",
      "Content-Disposition": `attachment; filename="${outName}"`,
    });
    res.send(outBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to process photo: " + err.message });
  }
});

function dmsToDecimal(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 3) return null;
  const part = (p) => (Array.isArray(p) ? (p[1] === 0 ? 0 : p[0] / p[1]) : p);
  const deg = part(dms[0]) + part(dms[1]) / 60 + part(dms[2]) / 3600;
  return ref === "S" || ref === "W" ? -deg : deg;
}

// Renders a raw EXIF tag value into something readable: rationals -> numbers,
// arrays of rationals (like GPS coordinates) -> comma-joined numbers.
function formatTagValue(value) {
  if (Array.isArray(value)) {
    const ratToNum = ([n, d]) => (d === 0 ? n : Math.round((n / d) * 1000) / 1000);
    if (value.length && Array.isArray(value[0])) return value.map(ratToNum).join(", ");
    if (value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      return ratToNum(value);
    }
    return value.join(", ");
  }
  if (typeof value === "string") return value.replace(/ +$/, "").trim();
  return value;
}

// Internal IFD-pointer tags (offsets to the Exif/GPS sub-IFDs) — structural
// plumbing, not information about the photo, so hide them from the report.
const IFD_POINTER_TAGS = new Set(["ExifTag", "GPSTag", "InteroperabilityTag"]);

function humanizeExif(exifObj) {
  const sectionLabels = { "0th": "Image", Exif: "Camera / Exif", GPS: "GPS", "1st": "Thumbnail", Interop: "Interop" };
  const sections = {};
  for (const sec of Object.keys(sectionLabels)) {
    const raw = exifObj[sec];
    if (!raw || !Object.keys(raw).length) continue;
    const tagMap = piexif.TAGS[sec] || {};
    const entries = {};
    for (const tagId of Object.keys(raw)) {
      const info = tagMap[tagId];
      const name = info ? info.name : `Tag${tagId}`;
      if (IFD_POINTER_TAGS.has(name)) continue;
      entries[name] = formatTagValue(raw[tagId]);
    }
    if (Object.keys(entries).length) sections[sectionLabels[sec]] = entries;
  }
  return sections;
}

app.post("/api/inspect", upload.single("photo"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No photo uploaded." });

    const meta = await sharp(file.buffer).metadata().catch(() => ({}));
    const result = {
      file: {
        name: file.originalname,
        sizeBytes: file.buffer.length,
        format: meta.format || null,
        width: meta.width || null,
        height: meta.height || null,
      },
      gps: null,
      exif: {},
    };

    const isJpeg = file.mimetype === "image/jpeg" || /\.jpe?g$/i.test(file.originalname);
    if (isJpeg) {
      let exifObj = null;
      try {
        exifObj = piexif.load(file.buffer.toString("binary"));
      } catch {
        exifObj = null;
      }
      if (exifObj) {
        result.exif = humanizeExif(exifObj);
        const gps = exifObj.GPS || {};
        const lat = dmsToDecimal(gps[piexif.GPSIFD.GPSLatitude], gps[piexif.GPSIFD.GPSLatitudeRef]);
        const lon = dmsToDecimal(gps[piexif.GPSIFD.GPSLongitude], gps[piexif.GPSIFD.GPSLongitudeRef]);
        if (lat != null && lon != null && !Number.isNaN(lat) && !Number.isNaN(lon)) {
          result.gps = { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
        }
      }
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to read metadata: " + err.message });
  }
});

const PORT = process.env.PORT || 3131;
app.listen(PORT, () => {
  console.log(`Decoy Drop running at http://localhost:${PORT}`);
});
