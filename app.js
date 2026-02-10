/* Config */
const SHEET_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRszYCdjHlFvMHkMvU9j8Mg8CHK6cou5R-PVJULGrNB9a9s3qrcvY2pSuPPwAjxOQ/pub?gid=1426119136&single=true&output=csv";

/* === Photos locales (remplace les placeholders) === */
const PHOTO_BASE = "./photosMinSquare"; // chemin vers ton dossier (relatif à index.html)

function photoURL(p){
  const prenom = String(p.prenom||"").trim();
  const nom    = String(p.nom||"").trim().toLocaleUpperCase('fr-FR');
  const base   = `${prenom} ${nom}`.replace(/\s+/g," ").trim(); // « Prénom NOM »
  return `${PHOTO_BASE}/${base}.jpg`;
}


/* Couleurs par entité (modifiable à volonté) */
const COMPANY_COLORS = {
  "Arwytec":                   "#a1cbb2ff",
  "ASSIST Conseils":           "#cd7228",
  "ASSIST Conseils Sud-Ouest": "#cd7228",
  "Epicure ing":               "#427e7f",
  "Collectivités Conseils":    "#7ba34d",
  "Hedera Services Group":     "#35578D",
  "Majalis":                   "#d8dce4",
  "Nuage Café":                "#e8bdb6",
  "OCADIA":                    "#555334",
  "SG Conseils":               "#70ced0",
  "Wheels and Ways":           "#9267c1",
  "Ithéa Conseil":             "#d13c33"
};

/* Utils */
const $ = (s)=>document.querySelector(s);
const $$ = (s)=>Array.from(document.querySelectorAll(s));
const norm = (s)=> (s||"").toString().normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
const tokens = (q)=> norm(q).split(/\s+/).filter(Boolean);
const parseNumber = (v)=>{
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return v;
  const s = String(v).replace(/\s/g,"").replace(",", "."); // gère 06 12 et décimaux FR
  return Number(s);
};

/* State */
let map;
let people = [];
let markers = [];
let activeCompanies = new Set();
let companyColors = new Map();
let currentPopupMarker = null;

// nouveau :
let markersLayer;   // L.layerGroup qui contient les marqueurs visibles
let oms;            // OverlappingMarkerSpiderfier

function ucFirstWord(str){
  const s = String(str || "").trim();
  const m = s.match(/\p{L}/u); // 1re lettre Unicode (gère é, à, ç…)
  if (!m) return s;
  const i = m.index;
  return s.slice(0, i) + s[i].toLocaleUpperCase('fr-FR') + s.slice(i+1);
}

function syncChipsAllState(){
  const wrap = $("#companies");
  const chips = $$("#companies .chip");
  const activeCount = chips.filter(c => c.classList.contains("active")).length;
  wrap.classList.toggle("all-active", chips.length > 0 && activeCount === chips.length);
}


/* Color per company */
/* Color per company */
function computePalette(items){
  const uniq = [...new Set(items.map(p => p.entite).filter(Boolean))];

  // Palette de secours si une entité n’est pas définie dans COMPANY_COLORS
  const fallback = [
    "#1DB5C5","#70BA7A","#EE2528","#F38331","#5C368D","#F9B832","#2ea76b",
    "#00753B","#1f8a70","#6078ea","#ffba49","#ef476f","#073b4c","#ffd166","#06d6a0"
  ];

  uniq.forEach((name, i) => {
    const override = COMPANY_COLORS[name];           // couleur imposée si dispo
    const color = override || fallback[i % fallback.length]; // sinon fallback
    companyColors.set(name, color);
  });

  return uniq;
}
// Texte simple pour l’étiquette hover
function simpleTipText(p){
  const nom = [p.prenom, p.nom].filter(Boolean).join(" ");
  return nom;
}


// Décalage (en pixels) converti en LatLng selon le zoom courant.
// Répartition en "anneaux hexagonaux" : 6, 12, 18, ... par anneau.
function jitterLatLng(baseLatLng, indexInGroup, groupSize){
  const zoom = map.getZoom();
  // Amplitude du jitter en px (diminue quand on zoome)
  const basePx = Math.max(0, Math.min(18, (14 + zoom) * 2 + 4));
  if (groupSize <= 1 || basePx === 0) return baseLatLng;

  // Trouver l’anneau et la position dans l’anneau (6, 12, 18, ...)
  let ring = 0, used = 0, cap = 6;
  while (indexInGroup >= used + cap){
    used += cap;
    ring++;
    cap = 6 + ring * 6;
  }
  const idxInRing = indexInGroup - used;
  const slots = cap;

  const radiusPx = basePx * (ring + 1);
  const angle = (2 * Math.PI * idxInRing) / slots;

  const p = map.latLngToLayerPoint(baseLatLng);
  const p2 = L.point(p.x + radiusPx * Math.cos(angle), p.y + radiusPx * Math.sin(angle));
  return map.layerPointToLatLng(p2);
}

// Recalcule et réapplique la position décalée (jitter) des marqueurs visibles
function reflowJitter(){
  if (!markersLayer || !map) return;
  const visibleIdx = markersLayer.__visibleIdx || [];
  // Regroupe les personnes visibles par coordonnées exactes (à ~1e-5° près)
  const groups = new Map(); // key -> [indices]
  visibleIdx.forEach((idx)=>{
    const p = people[idx];
    const key = `${(+p.lat).toFixed(5)},${(+p.lon).toFixed(5)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(idx);
  });

  // Met à jour la position de chaque marker selon son rang dans le groupe
  markersLayer.clearLayers();
  for (const [key, arr] of groups){
    const [lat, lon] = key.split(',').map(Number);
    const base = L.latLng(lat, lon);
    const n = arr.length;
    arr.forEach((idx, k)=>{
      const m = markers[idx];
      const j = jitterLatLng(base, k, n);
      m.setLatLng(j);
      markersLayer.addLayer(m);
    });
  }
}


/* DROM inset maps configuration */
const DROM_CONFIGS = [
  { name: "Guadeloupe", center: [16.25, -61.58], zoom: 9, bounds: [[15.8, -61.9], [16.6, -61.2]] },
  { name: "Martinique", center: [14.64, -61.02], zoom: 10, bounds: [[14.3, -61.3], [15.0, -60.7]] },
  { name: "Guyane", center: [3.93, -53.12], zoom: 7, bounds: [[2.0, -54.6], [5.8, -51.6]] },
  { name: "La Réunion", center: [-21.11, 55.53], zoom: 10, bounds: [[-21.4, 55.2], [-20.8, 55.8]] },
  { name: "Mayotte", center: [-12.83, 45.14], zoom: 11, bounds: [[-13.0, 44.9], [-12.6, 45.4]] }
];

let dromMaps = [];
let dromLayers = [];

function isDromCoord(lat, lon) {
  // Check if coordinates are in DROM bounds
  for (const drom of DROM_CONFIGS) {
    const [[minLat, minLon], [maxLat, maxLon]] = drom.bounds;
    if (lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon) {
      return drom;
    }
  }
  return null;
}

function initDromMaps(containerId, onMarkerClick) {
  const container = document.getElementById(containerId);
  if (!container) {
    console.log('[DROM] Container not found:', containerId);
    return;
  }

  console.log('[DROM] Initializing DROM maps in container:', containerId);

  // Clear existing
  dromMaps.forEach(m => {
    try { m.map.remove(); } catch(e) {}
  });
  dromMaps = [];
  dromLayers = [];
  container.innerHTML = '';

  DROM_CONFIGS.forEach((drom, idx) => {
    const inset = document.createElement('div');
    inset.className = 'drom-inset';
    inset.style.display = 'none'; // Hidden by default, shown when markers are added

    const mapDiv = document.createElement('div');
    mapDiv.className = 'drom-map';
    mapDiv.id = `drom-map-${idx}`;

    const label = document.createElement('div');
    label.className = 'drom-label';
    label.textContent = drom.name;

    inset.appendChild(mapDiv);
    inset.appendChild(label);
    container.appendChild(inset);

    // Create mini Leaflet map after DOM insertion
    setTimeout(() => {
      const miniMap = L.map(mapDiv.id, {
        zoomControl: false,
        attributionControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        keyboard: false,
        touchZoom: false
      }).setView(drom.center, drom.zoom);

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19
      }).addTo(miniMap);

      const layer = L.layerGroup().addTo(miniMap);

      dromMaps.push({ map: miniMap, config: drom, inset, layer });
      dromLayers.push(layer);

      // Invalidate size to ensure proper rendering
      setTimeout(() => miniMap.invalidateSize(), 100);
    }, 50);
  });

  console.log('[DROM] Created', DROM_CONFIGS.length, 'DROM inset maps');
}

function addDromMarker(dromIndex, lat, lon, color, clickHandler) {
  if (dromIndex < 0 || dromIndex >= dromMaps.length) {
    console.log('[DROM] Invalid dromIndex:', dromIndex);
    return;
  }

  const { map, inset, layer } = dromMaps[dromIndex];
  console.log('[DROM] Adding marker to', DROM_CONFIGS[dromIndex].name, 'at', lat, lon);

  // Show inset if hidden
  if (inset.style.display === 'none') {
    inset.style.display = 'block';
    console.log('[DROM] Showing inset for', DROM_CONFIGS[dromIndex].name);
  }

  const icon = L.divIcon({
    className: 'person-marker',
    html: `<span style="display:block; width:12px; height:12px; border-radius:50%;
      background:${color};
      border: 3px solid rgba(255,255,255,.95);
      box-shadow: 0 0 0 1px rgba(0,0,0,.45);"></span>`,
    iconSize: [18, 18]
  });

  const marker = L.marker([lat, lon], { icon });
  if (clickHandler) {
    marker.on('click', clickHandler);
  }
  layer.addLayer(marker);

  return marker;
}

/* Map */
function initMap(){
  map = L.map("map", { zoomControl:false }).setView([46.71109, 1.7191036], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(map);
  L.control.zoom({position:"bottomleft"}).addTo(map);

  // Calque simple qui affichera uniquement les marqueurs visibles (pas de cluster)
  markersLayer = L.layerGroup().addTo(map);

  // À chaque zoom, on recalcule le jitter pour les marqueurs visibles
  map.on('zoomend', reflowJitter);

  // Init DROM inset maps
  initDromMaps('dromContainer');
}



/* Data: CSV or GViz JSON */
async function loadSheet(){
  if (!SHEET_URL) throw new Error("SHEET_URL manquant. Renseigne window.__GSHEET_URL__ dans index.html");
  const res = await fetch(SHEET_URL);
  const text = await res.text();

  if (/google.visualization.Query.setResponse/.test(text)){
    // GViz JSON
    const json = JSON.parse(text.replace(/^[^{]+/, "").replace(/;?\s*$/, ""));
    const cols = json.table.cols.map(c => c.label || c.id);
    const rows = json.table.rows.map(r => r.c.map(c => c ? c.v : ""));
    return rowsToPeople([cols, ...rows]);
  } else if (text.trim().startsWith("{") || text.trim().startsWith("[")){
    // JSON brut (peu probable ici)
    const raw = JSON.parse(text);
    return normalizePeople(raw);
  } else {
    // CSV
    return csvToPeople(text);
  }
}

function csvToPeople(csv){
  const rows = [];
  let cur = [], val = "", inQuotes = false;
  for (let i=0;i<csv.length;i++){
    const ch = csv[i];
    if (ch === '"' ){
      if (inQuotes && csv[i+1] === '"'){ val += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes){ cur.push(val); val=""; }
    else if ((ch === '\n' || ch === '\r') && !inQuotes){
      if (val !== "" || cur.length){ cur.push(val); rows.push(cur); cur=[]; val=""; }
    } else { val += ch; }
  }
  if (val !== "" || cur.length) { cur.push(val); rows.push(cur); }

  // En-têtes sur première ligne
  const headers = rows[0].map(h => String(h).trim());
  const body = rows.slice(1);
  const table = body.map(r => Object.fromEntries(headers.map((h, i)=> [h, r[i]])));
  return normalizePeople(table);
}

function rowsToPeople(rows){
  const headers = rows[0].map(h => String(h).trim());
  const body = rows.slice(1).map(r => Object.fromEntries(headers.map((h,i)=> [h, r[i]])));
  return normalizePeople(body);
}

function normalizePeople(table){
  const pick = (row, names)=>{ for (const n of names){ if (n in row) return row[n]; } return ""; };

  const items = table.map(row => ({
    nom: pick(row, ["Nom","NOM"]),
    prenom: pick(row, ["Prénom","Prenom","PRENOM"]),
    entite: pick(row, ["Entité","Entreprise","ENTITE"]),
    email: pick(row, ["Adresse mail","Email","Mail","Courriel"]),
    tel: pick(row, ["Numéro de téléphone","Téléphone","Tel","Tél."]),
    poste: pick(row, ["Poste occupé","Poste","Fonction"]),
    ville : pick(row, ["Zone géographique","Localité","Localite"]),
    competences: pick(row, ["Compétences clés","Compétences","Competences"]),


    lat: parseNumber(pick(row, ["latitude","Lat","lat"])),
    lon: parseNumber(pick(row, ["longitude","Lon","lon","lng"]))
  }));

  return items.filter(p => !Number.isNaN(p.lat) && !Number.isNaN(p.lon) && (p.nom || p.prenom));
}


function parseCompetencesAndThematics(str){
  const out = { thematiques: [], competences: [] };
  if (!str) return out;

  // On sépare sur :, ;, , , |, puce • ou retour à la ligne
  const raw = String(str)
    .split(/(?:\s+[-–—\/]\s+)|[:;,\n|\u2022]+/)
    .map(s=>s.trim())
    .filter(Boolean);



  // Détection “mode thématique” : tout ce qui suit “Thématique(s)” jusqu'à un autre label
  let inThema = false;
  const isLabel = (t)=>{
    const n = norm(t);
    return /^(competence|competences|langue|langues|certification|certifications|outil|outils|expertise|expertises|domaine|domaines|theme|themes|thematique|thematiques)$/.test(n);
  };

  for (const token of raw){
    const n = norm(token);
    if (/^thematique/.test(n) || /^thematiques$/.test(n)){ inThema = true; continue; }
    if (isLabel(token)){ inThema = false; continue; }
    (inThema ? out.thematiques : out.competences).push(token);
  }

  // Unicité et nettoyage final
  out.thematiques = [...new Set(out.thematiques.map(s=>s.trim()))].filter(Boolean);
  out.competences = [...new Set(out.competences.map(s=>s.trim()))].filter(Boolean);
  return out;
}


/* Markers */
function personCardHTML(p){
  const mail = p.email ? `<a href="mailto:${p.email}" style="color:#334155; text-decoration:none;">${p.email}</a>` : "-";
  const tel  = p.tel ? `<a href="tel:${p.tel}" style="color:#334155; text-decoration:none;">${p.tel}</a>` : "-";
  const photo = photoURL(p);
  const altJpeg = photo.replace(/\.jpg$/i, '.jpeg'); // fallback si certaines photos sont en .jpeg
  return `
    <div class="popup-card">
        <img alt="Photo de ${p.prenom} ${p.nom}"
      src="${photo}"
      data-alt="${altJpeg}"
     />
      <div>
        <div class="name">${p.prenom} ${p.nom}</div>
        <div class="meta">${p.entite || ""} ${p.poste ? "• " + p.poste : ""}</div>
        <div class="meta">${p.ville|| " "}</div>
        <div class="meta">${tel} • ${mail}</div>
        <button class="btn" data-action="skills">Compétences clés</button>
      </div>
    </div>`;
}



function addMarkers(){
  // On ne met PAS tout de suite les marqueurs sur la carte ;
  // ils seront ajoutés selon le filtre via reflowJitter()
  markers.forEach(m => m.remove());
  markers = [];

  // Clear DROM layers (if they exist)
  if (dromLayers && dromLayers.length > 0) {
    dromLayers.forEach(layer => {
      try { layer.clearLayers(); } catch(e) {}
    });
  }
  if (dromMaps && dromMaps.length > 0) {
    dromMaps.forEach(({ inset }) => {
      if (inset) inset.style.display = 'none';
    });
  }

  people.forEach((p)=>{
    const color = companyColors.get(p.entite) || "#2ea76b";

    // Check if marker is in DROM
    const dromConfig = isDromCoord(p.lat, p.lon);

    if (dromConfig) {
      // Add to DROM inset map
      const dromIndex = DROM_CONFIGS.findIndex(d => d.name === dromConfig.name);
      if (dromIndex >= 0) {
        addDromMarker(dromIndex, p.lat, p.lon, color, () => openPopup(p, null));
      }
    } else {
      // Add to main map
      const icon = L.divIcon({
        className: 'person-marker',
        html: `
          <span style="
            display:block; width:16px; height:16px; border-radius:50%;
            background:${color};
            border: 3px solid rgba(255,255,255,.95);
            box-shadow: 0 0 0 1px rgba(0,0,0,.45);
          "></span>`,
        iconSize: [22,22]
      });

      const m = L.marker([p.lat, p.lon], { icon, riseOnHover:true, __entite: p.entite });

      // --- Hover: étiquette simple, non interactive, qui se ferme en sortant du point ---
      m.on('mouseover', () => {
        m.bindTooltip(simpleTipText(p), {
          className: 'mini-tip',
          direction: 'top',
          offset: [0,-14],
          opacity: 1,
          permanent: false,
          sticky: false,     // reste affichée uniquement tant que la souris est "sur" le point
          interactive: false // même si on passe sur l'étiquette, elle ne garde pas le focus
        }).openTooltip();
      });
      m.on('mouseout', () => { m.closeTooltip(); });

      // --- Clic: fiche complète (popup) ---
      m.on('click', () => openPopup(p, m));

      markers.push(m);
    }
  });
}




function openPopup(p, marker){
  // Ferme l’étiquette hover éventuelle
  if (marker.closeTooltip) marker.closeTooltip();

  // Ferme toute autre popup déjà ouverte (comportement “une seule ouverte”)
  if (map && map.closePopup) map.closePopup();
  if (currentPopupMarker && currentPopupMarker !== marker) {
    try { currentPopupMarker.closePopup(); } catch(e){}
  }

  const html = personCardHTML(p);

  // Rebind pour forcer les bonnes options (autoClose: true)
  marker.unbindPopup();
  marker.bindPopup(html, {
    closeButton: false,   // look “étiquette”
    autoPan: true,
    className: 'rich-popup',
    autoClose: true,      // ferme les autres popups à l’ouverture
    closeOnClick: true    // se ferme si on clique sur la carte
  }).openPopup();

  currentPopupMarker = marker;
  marker.once('popupclose', () => {
    if (currentPopupMarker === marker) currentPopupMarker = null;
  });

  // Bouton "Compétences clés" - attache robuste, sans propagation sur la carte
  requestAnimationFrame(() => {
    const pop = marker.getPopup && marker.getPopup();
    const root = pop && pop.getElement && pop.getElement();
    if (!root) return;

    if (window.L && L.DomEvent && L.DomEvent.disableClickPropagation){
      L.DomEvent.disableClickPropagation(root);
    }

    const btn = root.querySelector('.btn[data-action="skills"]');
    if (btn){
      const onClick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (window.L && L.DomEvent && L.DomEvent.stop) L.DomEvent.stop(ev);
        showSkills(p);
      };
      // Nettoie d’anciens handlers éventuels puis (re)attache
      btn.replaceWith(btn.cloneNode(true));
      root.querySelector('.btn[data-action="skills"]').addEventListener('click', onClick, { passive:false });
    }
  });
}


function ensureModal(){
  let modal = document.getElementById("modal");
  if (!modal){
    const tpl = document.createElement("div");
    tpl.innerHTML = `
      <div id="modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <div class="modal-card">
          <button id="modalClose" class="soft icon-only" aria-label="Fermer">✕</button>
          <div id="modalBody"></div>
        </div>
      </div>`;
    document.body.appendChild(tpl.firstElementChild);
    modal = document.getElementById("modal");
    // listeners de fermeture
    const close = ()=> modal.classList.add("hidden");
    document.getElementById("modalClose").addEventListener("click", close);
    modal.addEventListener("click", (e)=> { if (e.target.id === "modal") close(); });
    window.addEventListener("keydown", (e)=> { if (e.key === "Escape") close(); });
  }
  return modal;
}
// NEW - garantit que #modal, #modalTitle et #modalBody existent et renvoie leurs refs
function getModalEls(){
  let modal = document.getElementById("modal");
  let body  = document.getElementById("modalBody");

  // (Re)construit un modal minimal SANS titre général
  if (!modal || !body){
    if (modal) modal.remove();
    const tpl = document.createElement("div");
    tpl.innerHTML = `
      <div id="modal" class="modal hidden" role="dialog" aria-modal="true">
        <div class="modal-card">
          <button id="modalClose" class="soft icon-only" aria-label="Fermer">✕</button>
          <div id="modalBody"></div>
        </div>
      </div>`;
    document.body.appendChild(tpl.firstElementChild);

    modal = document.getElementById("modal");
    body  = document.getElementById("modalBody");

    const close = ()=> modal.classList.add("hidden");
    document.getElementById("modalClose").addEventListener("click", close);
    modal.addEventListener("click", (e)=> { if (e.target.id === "modal") close(); });
    window.addEventListener("keydown", (e)=> { if (e.key === "Escape") close(); });
  }

  // Si un ancien <h2 id="modalTitle"> traîne encore, on le retire
  const leftover = document.getElementById("modalTitle");
  if (leftover) leftover.remove();

  return { modal, body };
}




// REPLACE - version robuste de showSkills(p) qui utilise getModalEls()
function showSkills(p){
  const { modal, body } = getModalEls();
  const photo = photoURL(p);
  const altJpeg = photo.replace(/\.jpg$/i, '.jpeg');
  // Helpers UI (palette neutre)
  const chip = (t)=> `<span style="display:inline-block;margin:.125rem .25rem;padding:.32rem .7rem;border-radius:999px;background:#f2f4f7;color:#0f172a;font-size:.9rem;font-weight:600;border:1px solid #e5e7eb;">${ucFirstWord(t)}</span>`;
  const esc  = (s)=> String(s||"").replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  // Sépare sur " - ", " – ", " — " ou " / " (avec espaces autour), et sur : ; , • |
  const split = (s)=> String(s||"")
    .split(/(?:\s+[-–—\/]\s+)|[:;,\u2022|]+/)
    .map(t=>t.trim())
    .filter(Boolean);



  // Sections génériques depuis "Compétences clés" :
  // chaque ligne => "Titre: éléments ; séparés , | • ..."
function parseCompetencesSections(str){
  if (!str) return [];

  const lines = String(str).split(/\r?\n+/).map(l=>l.trim()).filter(Boolean);

  // Regroupe par titre logique
  const buckets = new Map(); // key -> Set(chips)

  const normTitleKey = (t) => {
    const n = norm(t);
    // Tout ce qui ressemble à "compétences", "compétences clés", ou vide → même seau
    return (!n || /^competences?(?:\s+cles?)?$/.test(n)) ? 'competences' : n;
  };

  for (const line of lines){
    const idx = line.indexOf(':');
    const rawTitle = idx > -1 ? line.slice(0, idx).trim() : '';
    const content  = idx > -1 ? line.slice(idx+1).trim() : line;

    const key = normTitleKey(rawTitle);
    if (!buckets.has(key)) buckets.set(key, new Set());

    // `split` existe déjà dans ton code (sépare ; , • | etc.)
    split(content).forEach(item => buckets.get(key).add(item.trim()));
  }

  // Fabrique les sections finales
  return [...buckets.entries()].map(([key, set]) => ({
    title: key === 'competences' ? 'Compétences' : ucFirstWord(key),
    chips: [...set].map(esc)
  }));
}


  const sections = parseCompetencesSections(p.competences);

  // Autres infos (si colonnes présentes dans le Sheet)
  const identite = [p.entite, p.poste].filter(Boolean).join(" • ");
  const ville = p.ville ? esc(p.ville) : "";
  const coord    = [
    p.tel ? `<a href="tel:${p.tel}" style="color:#334155; text-decoration:none;">${p.tel}</a>` : "",
    p.email ? `<a href="mailto:${p.email}" style="color:#334155; text-decoration:none;">${p.email}</a>` : ""
  ].filter(Boolean).join(" • ");

  body.innerHTML = `
    <!-- En-tête sans titre général : photo + Nom Prénom -->
    <div style="display:grid;grid-template-columns:96px 1fr;gap:1rem;align-items:center;margin-bottom:.5rem;line-height:1.4;">
    <img src="${photo}" alt="Photo de ${p.prenom} ${p.nom}" style="width:96px;height:96px;border-radius:12px;object-fit:cover;box-shadow:0 2px 10px rgba(0,0,0,.08);" />      <div>
        <div style="font-size:1.25rem;font-weight:800;color:#0f172a">${[p.prenom, p.nom].filter(Boolean).join(" ")}</div>
        <div style="color:#334155;">${identite || "-"}</div>
        <div style="color:#334155;">${ville}</div>
        ${coord ? `<div style="color:#334155;">${coord}</div>` : ""}
      </div>
    </div>

    <hr style="border:none;border-top:1px solid #e5e7eb;margin:.5rem 0 1rem;" />

    ${sections.length ? `
      <div style="margin-top:1rem;">
        ${sections.map(sec => `
          <div style="margin:.75rem 0;">
            <h3 style="margin:.25rem 0 .35rem;font-size:1.05rem;color:#0f172a;">${sec.title}</h3>
            ${sec.chips.length ? `<div>${sec.chips.map(chip).join(" ")}</div>` : `<div style="color:#6b7280;font-style:italic;">Aucun élément</div>`}
          </div>
        `).join("")}
      </div>` : ""}
  `;

  modal.classList.remove("hidden");
}







/* List UI */
function renderList(items){
  const ul = $("#people");
  ul.innerHTML = "";
  if (!items.length){
    $("#empty").classList.remove("hidden");
    return;
  }
  $("#empty").classList.add("hidden");

  const frag = document.createDocumentFragment();
  items.forEach(p=>{
    const li = document.createElement("li");
    li.className = "person";
    li.innerHTML = `
      <img alt="Photo de ${p.prenom} ${p.nom}"
        src="${photoURL(p)}"
        data-alt="${photoURL(p).replace(/\.jpg$/i, '.jpeg')}" />

      <div>
        <div class="name">${p.prenom} ${p.nom}</div>
        <div class="meta">${p.entite || ""} ${p.poste ? "• " + p.poste : ""}</div>
        <div class="meta">${p.ville || " "}</div>
        <div class="meta">${p.tel || "-"} • ${p.email ? `<a href="mailto:${p.email}">${p.email}</a>` : "-"}</div>
        <div class="actions">
          <button class="btn" data-action="focus">Voir sur la carte</button>
          <button class="btn" data-action="skills">Compétences clés</button>
        </div>
      </div>
    `;
    li.querySelector('[data-action="focus"]').addEventListener("click", ()=>{
    const idx = people.indexOf(p);
    const m = markers[idx];
    if (m){
      map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 9), { duration:.5 });
      // déclenche le mécanisme de spiderfy si des marqueurs se chevauchent
      setTimeout(()=> m.fire('click'), 520);
    }

    });
    li.querySelector('[data-action="skills"]').addEventListener("click", ()=> showSkills(p));

    frag.appendChild(li);
  });
  ul.appendChild(frag);
}

/* Filters */
function renderCompanyChips(all){
  const wrap = $("#companies");
  wrap.innerHTML = "";
  activeCompanies = new Set(all);

  all.forEach(name=>{
    const btn = document.createElement("button");
    btn.className = "chip active";
    btn.dataset.value = name;
    btn.textContent = name;
    btn.style.setProperty('--chip-color', companyColors.get(name) || '#2ea76b');

    btn.addEventListener("click", (e)=>{
      const exclusive = !(e.ctrlKey || e.metaKey);
      if (exclusive){
        // sélection exclusive
        activeCompanies = new Set([name]);
        $$("#companies .chip").forEach(c=> c.classList.toggle("active", c === btn));
      } else {
        // multi-sélection
        const willBeActive = !btn.classList.contains("active");
        btn.classList.toggle("active", willBeActive);
        if (willBeActive) activeCompanies.add(name); else activeCompanies.delete(name);

        // si plus aucune sélection => re-sélectionne tout
        if (!activeCompanies.size){
          activeCompanies = new Set(all);
          $$("#companies .chip").forEach(c=> c.classList.add("active"));
        }
      }
      syncChipsAllState();
      applyFilters();
    });

    wrap.appendChild(btn);
  });

  // état visuel initial : tout actif mais aspect "inactif"
  syncChipsAllState();
}


function applyFilters(){
  const q = $("#search").value || "";
  const tks = tokens(q);

  const filtered = people.filter(p=> activeCompanies.has(p.entite) && matchesQuery(p, tks));
  renderList(filtered);

  // Mémorise quels indices sont visibles, puis applique jitter + ajout au layer
  const idxByRef = new Map(people.map((p,i)=>[p, i]));
  markersLayer.__visibleIdx = filtered.map(p => idxByRef.get(p));

  reflowJitter(); // positionne et affiche uniquement les visibles
}



function matchesQuery(p, tks){
  if (!tks.length) return true;
  const hay = norm([p.nom, p.prenom, p.entite, p.poste, p.email, p.tel, p.competences].join(" "));
  return tks.every(t => hay.includes(t));
}

/* Export Excel */
function exportAnnuaireExcel() {
  if (!window.XLSX) {
    alert("Bibliothèque XLSX absente");
    return;
  }

  const searchInput = document.getElementById("search");
  const rawQuery = (searchInput.value || "").trim();
  const tks = tokens(rawQuery);

  const filtered = people.filter(p => {
    if (!activeCompanies.has(p.entite)) return false;
    if (!tks.length) return true;
    const hay = norm([p.nom, p.prenom, p.entite, p.poste, p.email, p.tel, p.competences].join(" "));
    return tks.every(t => hay.includes(t));
  });

  const exportData = filtered.map(p => ({
    "Nom": p.nom,
    "Prénom": p.prenom,
    "Entité": p.entite,
    "Poste": p.poste,
    "Ville": p.ville,
    "Email": p.email,
    "Téléphone": p.tel,
    "Compétences": p.competences
  }));

  const ws = XLSX.utils.json_to_sheet(exportData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Annuaire");

  // Nom de fichier avec date
  const dateStr = new Date().toISOString().slice(0, 10);
  const slug = (str) => {
    return String(str || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9-_]+/g, "_")
      .replace(/^_+|_+$/g, "");
  };

  const parts = ["annuaire"];
  if (rawQuery) parts.push(slug(rawQuery));
  parts.push(dateStr);

  const fname = `${parts.join("_")}.xlsx`;
  XLSX.writeFile(wb, fname);
}

/* Export JPG */
function exportMapJPG(mapId, title) {
  if (!window.html2canvas) {
    alert("Bibliothèque html2canvas absente");
    return;
  }

  const mapElement = document.getElementById(mapId);
  if (!mapElement) {
    alert("Carte non trouvée");
    return;
  }

  // Créer un overlay avec titre et légende
  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
    z-index: 9999;
  `;

  // Titre en haut
  const titleDiv = document.createElement("div");
  titleDiv.style.cssText = `
    position: absolute;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(255, 255, 255, 0.95);
    padding: 12px 24px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    font-size: 18px;
    font-weight: bold;
    color: #0c0f0e;
  `;
  titleDiv.textContent = title;
  overlay.appendChild(titleDiv);

  // Légende en bas
  const legendDiv = document.createElement("div");
  legendDiv.style.cssText = `
    position: absolute;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(255, 255, 255, 0.95);
    padding: 16px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    max-width: 90%;
  `;

  // Ajouter les entités actives avec leurs couleurs
  activeCompanies.forEach(company => {
    const color = companyColors.get(company) || '#2ea76b';
    const item = document.createElement("div");
    item.style.cssText = `
      display: flex;
      align-items: center;
      gap: 6px;
    `;

    const dot = document.createElement("div");
    dot.style.cssText = `
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: ${color};
      border: 3px solid rgba(255,255,255,.95);
      box-shadow: 0 0 0 1px rgba(0,0,0,.45);
      flex-shrink: 0;
    `;

    const label = document.createElement("span");
    label.style.cssText = `
      font-size: 12px;
      color: #0c0f0e;
      font-weight: 500;
    `;
    label.textContent = company;

    item.appendChild(dot);
    item.appendChild(label);
    legendDiv.appendChild(item);
  });

  overlay.appendChild(legendDiv);
  mapElement.appendChild(overlay);

  // Capturer la carte avec overlay
  html2canvas(mapElement, {
    useCORS: true,
    allowTaint: true,
    backgroundColor: '#0c0f0e',
    scale: 2
  }).then(sourceCanvas => {
    // Supprimer l'overlay
    overlay.remove();

    // Créer un canvas carré en prenant le minimum des dimensions
    const squareSize = Math.min(sourceCanvas.width, sourceCanvas.height);
    const squareCanvas = document.createElement('canvas');
    squareCanvas.width = squareSize;
    squareCanvas.height = squareSize;

    const ctx = squareCanvas.getContext('2d');

    // Calculer les offsets pour centrer l'image
    const offsetX = (sourceCanvas.width - squareSize) / 2;
    const offsetY = (sourceCanvas.height - squareSize) / 2;

    // Dessiner la partie centrale de l'image source
    ctx.drawImage(
      sourceCanvas,
      offsetX, offsetY, squareSize, squareSize,  // source
      0, 0, squareSize, squareSize               // destination
    );

    // Télécharger l'image carrée
    const link = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0, 10);
    link.download = `${title.toLowerCase().replace(/\s+/g, '_')}_${dateStr}.jpg`;
    link.href = squareCanvas.toDataURL('image/jpeg', 0.95);
    link.click();
  }).catch(err => {
    overlay.remove();
    console.error("Erreur lors de l'export JPG:", err);
    alert("Erreur lors de l'export de la carte");
  });
}

/* Bootstrap */
async function main(){
  initMap();
  try {
    people = await loadSheet();
  } catch (e){
    console.error(e);
    alert("Impossible de charger les données du Google Sheet. Vérifie l’URL de publication (CSV ou GViz JSON).");
    return;
  }

  const companies = computePalette(people);
  renderCompanyChips(companies);

  // Wait for DROM maps to be initialized before adding markers
  setTimeout(() => {
    addMarkers();
    renderList(people);
    applyFilters();
  }, 200);

  $("#filtersReset").addEventListener("click", ()=>{
    renderCompanyChips(companies);
    $("#search").value = "";
    applyFilters();
  });
  $("#clear").addEventListener("click", ()=>{
    $("#search").value = "";
    applyFilters();
  });
  $("#search").addEventListener("input", ()=> applyFilters());

  const toggle = $("#panelToggle");
  toggle.addEventListener("click", ()=>{
    const collapsed = document.body.classList.toggle("panel-collapsed");
    toggle.textContent = collapsed ? "⟨" : "⟩";
  });

  // Export buttons
  $("#annuaireExportExcel").addEventListener("click", exportAnnuaireExcel);
  $("#annuaireExportJPG").addEventListener("click", () => exportMapJPG("map", "Annuaire"));

  $("#modalClose").addEventListener("click", ()=> $("#modal").classList.add("hidden"));
  $("#modal").addEventListener("click", (e)=>{
    if (e.target.id === "modal") $("#modal").classList.add("hidden");
  });
}

document.addEventListener("DOMContentLoaded", main);
