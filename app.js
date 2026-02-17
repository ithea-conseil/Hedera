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
let activeDomains = new Set(); // Domaines actifs pour le filtrage
let domainsByEntity = new Map(); // Map<entite, Set<domaine>>
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

/* Compute domains per entity */
function computeDomainsByEntity(items){
  const domainMap = new Map();

  items.forEach(p => {
    const entity = p.entite;
    const domaineRaw = p.domaine || "";

    if (!entity) return;

    // Split domains by comma, semicolon, or pipe
    const domains = domaineRaw
      .split(/[,;|]+/)
      .map(d => d.trim())
      .filter(Boolean);

    if (!domainMap.has(entity)) {
      domainMap.set(entity, new Set());
    }

    domains.forEach(d => {
      domainMap.get(entity).add(d);
    });
  });

  return domainMap;
}

// Texte simple pour l'étiquette hover
function simpleTipText(p){
  const nom = [p.prenom, p.nom].filter(Boolean).join(" ");
  return nom;
}


// Décalage (en pixels) converti en LatLng selon le zoom courant.
// Répartition en "anneaux hexagonaux" : 6, 12, 18, ... par anneau.
function jitterLatLng(baseLatLng, indexInGroup, groupSize){
  const zoom = map.getZoom();
  // Amplitude du jitter en px (augmentée pour mieux séparer les marqueurs)
  // Formule: plus on est dézoomé, plus l'écartement est grand
  const basePx = Math.max(0, Math.min(18, (14 + zoom) * 2 + 4))
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
  
  // Regroupe les personnes visibles par coordonnées proches.
  // Modification : Tolérance augmentée à ~0.05° (environ 5.5km) au lieu de 0.001°
  const groups = new Map(); // key -> [indices]
  visibleIdx.forEach((idx)=>{
    const p = people[idx];
    // On utilise Math.round(coord * 20) pour arrondir au 0.05 près
    const latKey = Math.round(p.lat * 20);
    const lonKey = Math.round(p.lon * 20);
    const key = `${latKey},${lonKey}`;
    
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(idx);
  });

  // Met à jour la position de chaque marker selon son rang dans le groupe
  markersLayer.clearLayers();
  for (const [key, arr] of groups){
    // Pour la base du cluster visuel, on prend la position réelle du premier membre
    const firstP = people[arr[0]];
    const base = L.latLng(firstP.lat, firstP.lon);
    
    const n = arr.length;
    arr.forEach((idx, k)=>{
      const m = markers[idx];
      const j = jitterLatLng(base, k, n);
      m.setLatLng(j);
      markersLayer.addLayer(m);
    });
  }
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
    domaine: pick(row, ["Domaine","DOMAINE","Domaines"]),

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

  people.forEach((p)=>{
    const color = companyColors.get(p.entite) || "#2ea76b";
    const icon = L.divIcon({
      className: 'person-marker',
      html: `
        <span style="
          display:block; width:22px; height:22px; border-radius:50%;
          background:${color};
          box-shadow:
            0 0 0 2px rgba(255,255,255,.95) inset,
            0 0 0 1px rgba(0,0,0,.45);
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
        interactive: false // même si on passe sur l’étiquette, elle ne garde pas le focus
      }).openTooltip();
    });
    m.on('mouseout', () => { m.closeTooltip(); });

    // --- Clic: fiche complète (popup) ---
    m.on('click', () => openPopup(p, m));

    markers.push(m);
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
    // Create container for chip + domain bubbles
    const container = document.createElement("div");
    container.className = "chip-container";

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

    container.appendChild(btn);

    // Add domain bubbles if entity has domains
    const entityDomains = domainsByEntity.get(name);
    if (entityDomains && entityDomains.size > 0) {
      const domainsContainer = document.createElement("div");
      domainsContainer.className = "domain-bubbles";

      Array.from(entityDomains).forEach(domain => {
        const domainBubble = document.createElement("button");
        domainBubble.className = "domain-bubble";
        domainBubble.textContent = domain;
        domainBubble.dataset.domain = domain;

        // Check if domain is active
        if (activeDomains.has(domain)) {
          domainBubble.classList.add("active");
        }

        domainBubble.addEventListener("click", (e)=>{
          e.stopPropagation();
          toggleDomain(domain, name);
        });

        domainsContainer.appendChild(domainBubble);
      });

      container.appendChild(domainsContainer);
    }

    wrap.appendChild(container);
  });

  // état visuel initial : tout actif mais aspect "inactif"
  syncChipsAllState();
}

function toggleDomain(domain, entityName){
  console.log("[Domain Filter] Toggle domain:", domain);

  // If entity is not active, activate it first
  if (entityName && !activeCompanies.has(entityName)) {
    console.log("[Domain Filter] Activating parent entity:", entityName);
    activeCompanies.add(entityName);

    // Update chip visual state
    $$("#companies .chip").forEach(chip => {
      if (chip.dataset.value === entityName) {
        chip.classList.add("active");
      }
    });
  }

  if (activeDomains.has(domain)) {
    activeDomains.delete(domain);
    console.log("[Domain Filter] Removed domain:", domain);
  } else {
    activeDomains.add(domain);
    console.log("[Domain Filter] Added domain:", domain);
  }

  console.log("[Domain Filter] Active domains:", Array.from(activeDomains));

  // Update visual state of all domain bubbles
  $$(".domain-bubble").forEach(bubble => {
    const bubbleDomain = bubble.dataset.domain;
    bubble.classList.toggle("active", activeDomains.has(bubbleDomain));
  });

  syncChipsAllState();
  applyFilters();
}


function applyFilters(){
  const q = $("#search").value || "";
  const tks = tokens(q);

  console.log("[Filters] Applying filters - Active domains:", Array.from(activeDomains), "Active companies:", Array.from(activeCompanies));

  const filtered = people.filter(p=> {
    // Filter by entity
    if (!activeCompanies.has(p.entite)) return false;

    // Filter by domain (if any domains are selected)
    if (activeDomains.size > 0) {
      // Parse domains from THIS specific person
      const personDomains = (p.domaine || "")
        .split(/[,;|]+/)
        .map(d => d.trim())
        .filter(Boolean);

      if (personDomains.length === 0) return false;

      // Check if THIS person has at least one of the active domains
      let hasActiveDomain = false;
      for (const domain of activeDomains) {
        if (personDomains.includes(domain)) {
          hasActiveDomain = true;
          break;
        }
      }
      if (!hasActiveDomain) return false;
    }

    // Filter by search query
    return matchesQuery(p, tks);
  });

  console.log("[Filters] Filtered results:", filtered.length, "out of", people.length);

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

/* Export Excel pour Annuaire */
function annuaireExportExcel() {
  if (!window.XLSX) {
    alert("Bibliothèque XLSX absente");
    return;
  }

  const searchInput = document.getElementById("search");
  const rawQuery = (searchInput.value || "").trim();
  const tks = tokens(rawQuery);

  const filtered = people.filter(p => {
    if (!activeCompanies.has(p.entite)) return false;

    // Filter by domain (if any domains are selected)
    if (activeDomains.size > 0) {
      const personDomains = (p.domaine || "")
        .split(/[,;|]+/)
        .map(d => d.trim())
        .filter(Boolean);

      if (personDomains.length === 0) return false;

      let hasActiveDomain = false;
      for (const domain of activeDomains) {
        if (personDomains.includes(domain)) {
          hasActiveDomain = true;
          break;
        }
      }
      if (!hasActiveDomain) return false;
    }

    return matchesQuery(p, tks);
  });

  const exportData = filtered.map(p => ({
    "Prénom": p.prenom,
    "Nom": p.nom,
    "Entité": p.entite,
    "Poste": p.poste,
    "Ville": p.ville,
    "Téléphone": p.tel,
    "Email": p.email,
    "Compétences": p.competences
  }));

  const ws = XLSX.utils.json_to_sheet(exportData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Annuaire");

  // Construction du nom de fichier
  const searchPart = rawQuery;
  const activeChips = document.querySelectorAll("#companies .chip.active");
  let chipPart = "";
  if (activeChips.length === 1) {
    chipPart = (activeChips[0].dataset.value || activeChips[0].textContent || "").trim();
  }

  const dateStr = new Date().toISOString().slice(0, 10);

  const slug = (str) => {
    return String(str || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9-_]+/g, "_")
      .replace(/^_+|_+$/g, "");
  };

  const hasSearch = !!searchPart;
  const hasChip = !!chipPart;

  const parts = [];
  if (!hasSearch && !hasChip) {
    parts.push("annuaire");
  }
  if (hasSearch) {
    parts.push(slug(searchPart));
  }
  if (hasChip) {
    parts.push(slug(chipPart));
  }
  parts.push(dateStr);

  const baseName = parts.join("_");
  const fname = `${baseName}.xlsx`;

  XLSX.writeFile(wb, fname);
}

/* Export JPG pour Annuaire */
async function annuaireExportJpg() {
  if (!window.domtoimage) {
    alert("Bibliothèque dom-to-image absente");
    return;
  }

  await exportMapAsJpg(map, "annuaire", activeCompanies, companyColors, "map");
}

/* Fonction générique d'export JPG */
async function exportMapAsJpg(mapInstance, sectionName, activeEntities, entityColors, mapElementId, customTitle = null) {
  try {
    if (!window.domtoimage) {
      alert("Bibliothèque dom-to-image absente");
      return;
    }

    // Message de chargement
    const loadingMsg = document.createElement('div');
    loadingMsg.textContent = 'Génération de l\'export en cours...';
    loadingMsg.style.position = 'fixed';
    loadingMsg.style.top = '50%';
    loadingMsg.style.left = '50%';
    loadingMsg.style.transform = 'translate(-50%, -50%)';
    loadingMsg.style.padding = '20px';
    loadingMsg.style.backgroundColor = '#000';
    loadingMsg.style.color = '#fff';
    loadingMsg.style.borderRadius = '8px';
    loadingMsg.style.zIndex = '10000';
    document.body.appendChild(loadingMsg);

    // Dimensions du canvas final (2000x2000 carré)
    const finalSize = 2000;
    const legendHeight = 400;
    const mapHeight = finalSize - legendHeight;

    // Cacher temporairement les contrôles de zoom
    const mapElement = document.getElementById(mapElementId);
    const zoomControl = mapElement.querySelector('.leaflet-control-zoom');
    const wasHidden = zoomControl && zoomControl.style.display === 'none';
    if (zoomControl && !wasHidden) {
      zoomControl.style.display = 'none';
    }

		const mapDataUrl = await domtoimage.toPng(mapElement, {
			width: mapElement.offsetWidth,
			height: mapElement.offsetHeight,
			style: { transform: 'scale(1)', transformOrigin: 'top left' }
		});

    // Réafficher les contrôles de zoom
    if (zoomControl && !wasHidden) {
      zoomControl.style.display = '';
    }

    // Créer une image depuis le dataURL
    const mapImage = new Image();
    await new Promise((resolve, reject) => {
      mapImage.onload = resolve;
      mapImage.onerror = reject;
      mapImage.src = mapDataUrl;
    });

    // Créer le canvas final
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = finalSize;
    finalCanvas.height = finalSize;
    const ctx = finalCanvas.getContext('2d');

    // Fond blanc
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, finalSize, finalSize);

    // Crop la carte pour remplir toute la zone (plein écran)
    const sourceAspect = mapImage.width / mapImage.height;
    const targetAspect = finalSize / mapHeight;

    let srcX, srcY, srcWidth, srcHeight;

    if (sourceAspect > targetAspect) {
      // L'image source est plus large : on crop les côtés
      srcHeight = mapImage.height;
      srcWidth = mapImage.height * targetAspect;
      srcX = (mapImage.width - srcWidth) / 2;
      srcY = 0;
    } else {
      // L'image source est plus haute : on crop le haut/bas
      srcWidth = mapImage.width;
      srcHeight = mapImage.width / targetAspect;
      srcX = 0;
      srcY = (mapImage.height - srcHeight) / 2;
    }

// Dessiner la carte principale (crop et plein écran)
    ctx.drawImage(mapImage, srcX, srcY, srcWidth, srcHeight, 0, 0, finalSize, mapHeight);

    // Dessiner la légende en bas
    const legendY = mapHeight;

    // Fond de la légende (blanc)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, legendY, finalSize, legendHeight);

    // Titres professionnels selon la section
    const professionalTitles = {
      'annuaire': 'Cartographie des membres du groupe Hedera',
      'references': 'Cartographie des références du groupe Hedera',
      'veille': 'Veille concurrentielle'
    };
    // Priorité au titre personnalisé, sinon mapping, sinon nom de section
    const displayTitle = customTitle || professionalTitles[sectionName] || sectionName;

    // Titre de la légende (aligné à gauche)
    ctx.fillStyle = '#000';
    ctx.font = 'bold 42px Arial';
    ctx.textAlign = 'left';
    ctx.fillText(displayTitle, 40, legendY + 60);

    // Modification : On ne dessine la légende que si ce n'est PAS la section 'veille'
    if (sectionName !== 'veille') {
        const entitiesArray = Array.from(activeEntities);

        // Layout modifié : plus d'espace pour éviter les chevauchements
        const leftMargin = 40;
        const rightMargin = 40;
        const itemsPerRow = 3; // Réduit de 5 à 3 colonnes
        const colWidth = (finalSize - leftMargin - rightMargin) / itemsPerRow;

        const startY = legendY + 130;
        const rowHeight = 55;

        const radius = 15;
        const dotGap = 12;

        ctx.font = '40px Arial'; // Police légèrement réduite
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        entitiesArray.forEach((entityName, index) => {
          const col = index % itemsPerRow;
          const row = Math.floor(index / itemsPerRow);

          const x0 = leftMargin + col * colWidth;
          const y  = startY + row * rowHeight;

          const dotX = x0 + radius;
          const dotY = y;

          const color = entityColors.get(entityName) || "#2ea76b";

          // Cercle
          ctx.fillStyle = color;
          ctx.beginPath(); ctx.arc(dotX, dotY, radius, 0, Math.PI * 2); ctx.fill();
          
          // Bordures
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(dotX, dotY, radius - 1, 0, Math.PI * 2); ctx.stroke();
          
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(dotX, dotY, radius, 0, Math.PI * 2); ctx.stroke();

          // Texte
          ctx.fillStyle = '#000';
          ctx.fillText(entityName, dotX + radius + dotGap, dotY);
        });
    }


    // Supprimer le message de chargement
    document.body.removeChild(loadingMsg);

    // Télécharger
    const dataUrl = finalCanvas.toDataURL('image/jpeg', 0.95);
    const link = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0, 10);
    link.download = `${sectionName}_${dateStr}.jpg`;
    link.href = dataUrl;
    link.click();

  } catch (error) {
    console.error("Erreur lors de l'export JPG:", error);
    alert("Erreur lors de l'export JPG: " + error.message);
    const loadingMsg = document.querySelector('div[style*="Génération"]');
    if (loadingMsg) document.body.removeChild(loadingMsg);
  }
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
  domainsByEntity = computeDomainsByEntity(people);
  renderCompanyChips(companies);
  addMarkers();
  renderList(people);
  applyFilters();

  $("#filtersReset").addEventListener("click", ()=>{
    activeDomains.clear();
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

  $("#modalClose").addEventListener("click", ()=> $("#modal").classList.add("hidden"));
  $("#modal").addEventListener("click", (e)=>{
    if (e.target.id === "modal") $("#modal").classList.add("hidden");
  });

  // Boutons d'export
  $("#annuaireExportExcel").addEventListener("click", annuaireExportExcel);
  $("#annuaireExportJpg").addEventListener("click", annuaireExportJpg);
}

/* Export for global access */
window.exportMapAsJpg = exportMapAsJpg;

document.addEventListener("DOMContentLoaded", main);
