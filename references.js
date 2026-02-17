/* ===== Module Références ===== */

/* Config - URL du Google Sheet Références */
const REF_SHEET_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRszYCdjHlFvMHkMvU9j8Mg8CHK6cou5R-PVJULGrNB9a9s3qrcvY2pSuPPwAjxOQ/pub?gid=1805966598&single=true&output=csv";

/* Couleurs par entité (identiques à app.js pour cohérence) */
const REF_COMPANY_COLORS = {
  "Arwytec": "#a1cbb2ff",
  "Assist Conseils": "#cd7228",
  "Assist Conseils Sud-Ouest": "#cd7228",
  "Epicure ing": "#427e7f",
  "Collectivités Conseils": "#7ba34d",
  "Hedera Services Group": "#35578D",
  "Majalis": "#d8dce4",
  "Nuage Café": "#e8bdb6",
  "OCADIA": "#555334",
  "SG Conseils": "#70ced0",
  "Wheels and Ways": "#9267c1",
  "Ithéa Conseil": "#d13c33"
};

/* Utils */
const refNorm = (s) => (s || "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const refTokens = (q) => refNorm(q).split(/\s+/).filter(Boolean);
const refParseNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  // Gère les formats : "1 000", "1000", "1 000,50", "1000.50", "1000€", "1 000 €"
  const s = String(v).replace(/\s+/g, "").replace(/€/g, "").replace(",", ".");
  const num = Number(s);
  return Number.isNaN(num) ? null : num;
};

/* State */
let refMap;
let references = [];
let refMarkers = [];
let refActiveCompanies = new Set();
let refCompanyColors = new Map();
let refActiveDomains = new Set(); // Domaines actifs pour le filtrage
let refDomainsByEntity = new Map(); // Map<entite, Set<domaine>>
let refMarkersLayer;

// --- Jitter des marqueurs (répartition en anneaux hexagonaux) ---
function refJitterLatLng(baseLatLng, indexInGroup, groupSize){
  if (!refMap) return baseLatLng;
  const zoom = refMap.getZoom();
  // amplitude en pixels (diminue quand on zoome)
  const basePx = Math.max(0, Math.min(18, (14 + zoom) * 2 + 4));
  if (groupSize <= 1 || basePx === 0) return baseLatLng;

  // Anneaux de 6, 12, 18, ... points
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

  const p = refMap.latLngToLayerPoint(baseLatLng);
  const p2 = L.point(p.x + radiusPx * Math.cos(angle), p.y + radiusPx * Math.sin(angle));
  return refMap.layerPointToLatLng(p2);
}

// Recalcule la position décalée des marqueurs visibles et les (ré)ajoute au layer
function refReflowJitter(){
  if (!refMarkersLayer || !refMap) return;
  const visibleIdx = refMarkersLayer.__visibleIdx || [];

  // regroupe par coordonnées exactes (~1e-5°)
  const groups = new Map(); // "lat,lon" -> [indices]
  visibleIdx.forEach((idx)=>{
    const r = references[idx];
    const key = `${(+r.lat).toFixed(5)},${(+r.lon).toFixed(5)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(idx);
  });

  refMarkersLayer.clearLayers();
  for (const [key, arr] of groups){
    const [lat, lon] = key.split(',').map(Number);
    const base = L.latLng(lat, lon);
    const n = arr.length;
    arr.forEach((idx, k)=>{
      const m = refMarkers[idx];
      if (!m) return;
      const j = refJitterLatLng(base, k, n);
      m.setLatLng(j);
      refMarkersLayer.addLayer(m);
    });
  }
}


/* Format helpers */
function fmtMoney(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "";
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(v);
}

/* Color palette */
function refComputePalette(items) {
  const uniq = [...new Set(items.map(r => r.entite).filter(Boolean))];
  const fallback = [
    "#1DB5C5", "#70BA7A", "#EE2528", "#F38331", "#5C368D", "#F9B832", "#2ea76b",
    "#00753B", "#1f8a70", "#6078ea", "#ffba49", "#ef476f", "#073b4c", "#ffd166", "#06d6a0"
  ];

  uniq.forEach((name, i) => {
    const override = REF_COMPANY_COLORS[name];
    const color = override || fallback[i % fallback.length];
    refCompanyColors.set(name, color);
  });

  return uniq;
}

/* Compute domains per entity */
function refComputeDomainsByEntity(items){
  const domainMap = new Map();

  items.forEach(r => {
    const entity = r.entite;
    const domaineRaw = r.domaine || "";

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

/* Init Leaflet map for References */
function initRefMap() {
  if (!refMap) {
    refMap = L.map("refMap", { zoomControl: false }).setView([46.71109, 1.7191036], 6);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }).addTo(refMap);
    L.control.zoom({ position: "bottomleft" }).addTo(refMap);
    refMarkersLayer = L.layerGroup().addTo(refMap);

    // Recalcule l’écartement quand on zoome/dézoome
    refMap.on('zoomend', refReflowJitter);

    
    // Force l'invalidation de la taille après un court délai
    setTimeout(() => {
      if (refMap) refMap.invalidateSize();
    }, 100);
  }
}

/* Load data from Google Sheet */
async function loadReferences() {
  if (!REF_SHEET_URL) throw new Error("REF_SHEET_URL manquant");
  const res = await fetch(REF_SHEET_URL);
  const text = await res.text();

  // Parse CSV
  const rows = [];
  let cur = [], val = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { val += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) { cur.push(val); val = ""; }
    else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (val !== "" || cur.length) { cur.push(val); rows.push(cur); cur = []; val = ""; }
    } else { val += ch; }
  }
  if (val !== "" || cur.length) { cur.push(val); rows.push(cur); }

  // Headers are in row 5 (index 4), data starts at row 6
  if (rows.length < 5) throw new Error("Pas assez de lignes dans le CSV");
  
  const headers = rows[4].map(h => String(h).trim());
  console.log("[Références] En-têtes détectées :", headers);
  const dataRows = rows.slice(5);
  console.log("[Références] Nombre de lignes de données :", dataRows.length);

  const items = dataRows.map((row, idx) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] || ""; });
    
    const lat = refParseNumber(obj["lat"]);
    const lon = refParseNumber(obj["lon"]);
    
    const item = {
      entite: obj["Entité"] || "",
      intitule: obj["Intitulé mission"] || "",
      territoire: obj["Territoire"] || "",
      annee: obj["Année"] || "",
      cheffe: obj["Cheffe de projet"] || "",
      titreReferent: obj["Titre référent"] || "",
      nomReferent: obj["Nom référent"] || "",
      mail: obj["Mail"] || "",
      tel: obj["Tél"] || "",
      montant: refParseNumber(obj["Montant"]),
      domaine: obj["Domaine"] || "",
      lat: lat,
      lon: lon
    };
    
    // Debug première ligne
    if (idx === 0) {
      console.log("[Références] Exemple première ligne:", item);
    }
    
    return item;
  });

  // Filtre : on garde les lignes avec lat/lon valides
  const validItems = items.filter(r => r.lat !== null && r.lon !== null);
  console.log("[Références] Lignes valides (avec coordonnées):", validItems.length);
  
  return validItems;
}

/* Create markers */
function refAddMarkers() {
  refMarkers.forEach(m => m.remove());
  refMarkers = [];
  if (!refMarkersLayer) return;

  references.forEach((ref) => {
    const color = refCompanyColors.get(ref.entite) || "#2ea76b";
    const icon = L.divIcon({
      className: 'person-marker',
      html: `<span style="display:block; width:18px; height:18px; border-radius:50%;
        background:${color};
        box-shadow: 0 0 0 2px rgba(255,255,255,.95) inset, 0 0 0 1px rgba(0,0,0,.45);
        "></span>`,
      iconSize: [18, 18]
    });

    const m = L.marker([ref.lat, ref.lon], { icon, riseOnHover: true, __entite: ref.entite });

    // Hover tooltip - format simple comme l'Annuaire
    m.on('mouseover', () => {
    const tooltip = String(ref.intitule || "").trim();
    m.bindTooltip(tooltip || "Référence", {
      className: 'mini-tip ref-tip',   // <- extra classe pour cibler le style
      direction: 'top',
      offset: [0, -12.5],
      opacity: 1,
      permanent: false,
      sticky: false,
      interactive: false
    }).openTooltip();

    });
    m.on('mouseout', () => { m.closeTooltip(); });

    // Click: detailed popup
    m.on('click', () => refOpenPopup(ref, m));

    refMarkers.push(m);
  });
}

/* Popup with all 9 columns - format similaire à l'Annuaire */
function refOpenPopup(ref, marker) {
  if (marker.closeTooltip) marker.closeTooltip();
  if (refMap && refMap.closePopup) refMap.closePopup();

  const color = refCompanyColors.get(ref.entite) || "#2ea76b";
  const initial = (ref.entite || "?").charAt(0).toUpperCase();
  
const html = `
  <div class="popup-card ref-popup-card">
    ${ref.territoire ? `<div class="territory-pill">${ref.territoire}</div>` : ""}

    <div class="ref-popup-main">
      <div style="width:50px; height:50px; min-width:50px; border-radius:50%; background:${color}; display:flex; align-items:center; justify-content:center; color:#fff; font-weight:800; font-size:18px;">
        ${initial}
      </div>
      <div class="ref-popup-body">
        <div class="name">${ref.intitule || ""}</div>

        <div class="meta">
          ${ref.annee || ""} ${ref.cheffe ? "• " + ref.cheffe : ""}
        </div>

        ${(ref.titreReferent || ref.nomReferent) 
          ? `<div class="meta"><strong>Référent :</strong> ${ref.titreReferent || ""} ${ref.nomReferent || ""}</div>`
          : ""}

        <div class="meta">
          ${ref.tel || ""} 
          ${ref.mail ? `• <a href="mailto:${ref.mail}">${ref.mail}</a>` : ""}
        </div>

        ${ref.montant != null && ref.montant !== ""
          ? `<div class="meta"><strong>Montant :</strong> ${fmtMoney(ref.montant)}</div>`
          : ""}
      </div>
    </div>
  </div>`;



  marker.unbindPopup();
  marker.bindPopup(html, {
    closeButton: false,
    autoPan: true,
    className: 'rich-popup',
    autoClose: true,
    closeOnClick: true
  }).openPopup();
}

/* Render list of references */
function refRenderList(items) {
  const refItemsList = document.getElementById("refItems");
  const refEmptyMsg = document.getElementById("refEmpty");
  
  refItemsList.innerHTML = "";
  if (!items.length) {
    refEmptyMsg.classList.remove("hidden");
    return;
  }
  refEmptyMsg.classList.add("hidden");

  const frag = document.createDocumentFragment();
  items.forEach(ref => {
    const li = document.createElement("li");
    li.className = "person";
    const color = refCompanyColors.get(ref.entite) || '#2ea76b';
    const initial = (ref.entite || "?").charAt(0).toUpperCase();
    
    // ➜ plus de bouton "Voir sur la carte"
    li.innerHTML = `
      ${ref.territoire 
        ? `<div class="territory-pill">${ref.territoire}</div>` 
        : ""}

      <div class="person-main">
        <div class="person-avatar" style="width:50px; height:50px; min-width:50px; border-radius:50%; background:${color}; display:flex; align-items:center; justify-content:center; color:#fff; font-weight:700; font-size:18px; border:2px solid rgba(255,255,255,.35);">
          ${initial}
        </div>
        <div class="person-body">
          <div class="name">${ref.intitule || ""}</div>
          <div class="meta">${ref.annee || ""} ${ref.cheffe ? "• " + ref.cheffe : ""}</div>
          <div class="meta">${fmtMoney(ref.montant)}</div>
        </div>
      </div>
    `;


    // ➜ clic sur toute la ligne = comportement "Voir sur la carte"
    li.addEventListener("click", () => {
      const idx = references.indexOf(ref);
      const m = refMarkers[idx];
      if (m && refMap) {
        refMap.flyTo(m.getLatLng(), Math.max(refMap.getZoom(), 9), { duration: .5 });
        setTimeout(() => m.fire('click'), 520);
      }
    });

    frag.appendChild(li);
  });
  refItemsList.appendChild(frag);
}


/* Render company chips */
function refRenderCompanyChips(all) {
  const refFiltersContainer = document.getElementById("refFilters");
  refFiltersContainer.innerHTML = "";
  refActiveCompanies = new Set(all);

  all.forEach(name => {
    // Create container for chip + domain bubbles
    const container = document.createElement("div");
    container.className = "chip-container";

    const btn = document.createElement("button");
    btn.className = "chip active";
    btn.dataset.value = name;
    btn.textContent = name;
    btn.style.setProperty('--chip-color', refCompanyColors.get(name) || '#2ea76b');

    btn.addEventListener("click", (e) => {
      const exclusive = !(e.ctrlKey || e.metaKey);
      if (exclusive) {
        refActiveCompanies = new Set([name]);
        document.querySelectorAll("#refFilters .chip").forEach(c => c.classList.toggle("active", c === btn));
      } else {
        const willBeActive = !btn.classList.contains("active");
        btn.classList.toggle("active", willBeActive);
        if (willBeActive) refActiveCompanies.add(name); else refActiveCompanies.delete(name);

        if (!refActiveCompanies.size) {
          refActiveCompanies = new Set(all);
          document.querySelectorAll("#refFilters .chip").forEach(c => c.classList.add("active"));
        }
      }
      refApplyFilters();
    });

    container.appendChild(btn);

    // Add domain bubbles if entity has domains
    const entityDomains = refDomainsByEntity.get(name);
    if (entityDomains && entityDomains.size > 0) {
      const domainsContainer = document.createElement("div");
      domainsContainer.className = "domain-bubbles";

      Array.from(entityDomains).forEach(domain => {
        const domainBubble = document.createElement("button");
        domainBubble.className = "domain-bubble";
        domainBubble.textContent = domain;
        domainBubble.dataset.domain = domain;

        // Check if domain is active
        if (refActiveDomains.has(domain)) {
          domainBubble.classList.add("active");
        }

        domainBubble.addEventListener("click", (e)=>{
          e.stopPropagation();
          refToggleDomain(domain);
        });

        domainsContainer.appendChild(domainBubble);
      });

      container.appendChild(domainsContainer);
    }

    refFiltersContainer.appendChild(container);
  });
}

function refToggleDomain(domain){
  if (refActiveDomains.has(domain)) {
    refActiveDomains.delete(domain);
  } else {
    refActiveDomains.add(domain);
  }

  // Update visual state of all domain bubbles
  document.querySelectorAll(".domain-bubble").forEach(bubble => {
    const bubbleDomain = bubble.dataset.domain;
    bubble.classList.toggle("active", refActiveDomains.has(bubbleDomain));
  });

  refApplyFilters();
}

/* Apply filters */
function refApplyFilters() {
  const refSearchInput = document.getElementById("refSearch");
  const q = refSearchInput.value || "";
  const tks = refTokens(q);

  const filtered = references.filter(ref => {
    // Filter by entity
    if (!refActiveCompanies.has(ref.entite)) return false;

    // Filter by domain (if any domains are selected)
    if (refActiveDomains.size > 0) {
      const entityDomains = refDomainsByEntity.get(ref.entite);
      if (!entityDomains || entityDomains.size === 0) return false;

      // Check if entity has at least one of the active domains
      let hasActiveDomain = false;
      for (const domain of refActiveDomains) {
        if (entityDomains.has(domain)) {
          hasActiveDomain = true;
          break;
        }
      }
      if (!hasActiveDomain) return false;
    }

    // Filter by search query
    if (!tks.length) return true;
    const hay = refNorm([ref.entite, ref.intitule, ref.territoire, ref.annee, ref.cheffe, ref.nomReferent, ref.titreReferent].join(" "));
    return tks.every(t => hay.includes(t));
  });

  refRenderList(filtered);

  // Update map (avec jitter)
  if (refMarkersLayer) {
    // mémorise l'ensemble des indices visibles dans l'ordre de la liste filtrée
    const idxByRef = new Map(references.map((r,i)=>[r, i]));
    refMarkersLayer.__visibleIdx = filtered.map(r => idxByRef.get(r));

    // applique l'écartement en fonction du zoom courant
    refReflowJitter();
  }

}

/* Export to Excel */
/* Export to Excel */
/* Export to Excel */
function refExportExcel() {
  if (!window.XLSX) { 
    alert("Bibliothèque XLSX absente"); 
    return; 
  }

  const refSearchInput = document.getElementById("refSearch");
  const rawQuery = (refSearchInput.value || "").trim();
  const tks = refTokens(rawQuery);

  const filtered = references.filter(ref => {
    if (!refActiveCompanies.has(ref.entite)) return false;

    // Filter by domain (if any domains are selected)
    if (refActiveDomains.size > 0) {
      const entityDomains = refDomainsByEntity.get(ref.entite);
      if (!entityDomains || entityDomains.size === 0) return false;

      let hasActiveDomain = false;
      for (const domain of refActiveDomains) {
        if (entityDomains.has(domain)) {
          hasActiveDomain = true;
          break;
        }
      }
      if (!hasActiveDomain) return false;
    }

    if (!tks.length) return true;
    const hay = refNorm([
      ref.entite,
      ref.intitule,
      ref.territoire,
      ref.annee,
      ref.cheffe,
      ref.nomReferent,
      ref.titreReferent
    ].join(" "));
    return tks.every(t => hay.includes(t));
  });

  const exportData = filtered.map(r => ({
    "Entité": r.entite,
    "Intitulé mission": r.intitule,
    "Territoire": r.territoire,
    "Année": r.annee,
    "Cheffe de projet": r.cheffe,
    "Titre référent": r.titreReferent,
    "Nom référent": r.nomReferent,
    "Mail": r.mail,
    "Tél": r.tel,
    "Montant": r.montant
  }));

  const ws = XLSX.utils.json_to_sheet(exportData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Références");

  // --- Construction du nom de fichier ---

  // 1) valeur de l'input refSearch
  const searchPart = rawQuery;

  // 2) nom du .chip.active s'il y en a un seul
  const activeChips = document.querySelectorAll("#refFilters .chip.active");
  let chipPart = "";
  if (activeChips.length === 1) {
    chipPart = (activeChips[0].dataset.value || activeChips[0].textContent || "").trim();
  }

  // 3) date du jour (YYYY-MM-DD)
  const dateStr = new Date().toISOString().slice(0, 10);

  // 4) fonction pour nettoyer les morceaux (accents, espaces, etc.)
  const slug = (str) => {
    return String(str || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // enlève les accents
      .replace(/[^a-zA-Z0-9-_]+/g, "_")                // caractères spéciaux -> "_"
      .replace(/^_+|_+$/g, "");                        // supprime "_" début/fin
  };

  const hasSearch = !!searchPart;
  const hasChip   = !!chipPart;

  const parts = [];

  // ⬇️ Par défaut, quand il n’y a AUCUN filtre, on ajoute "references_"
  if (!hasSearch && !hasChip) {
    parts.push("references"); // équivalent "références", déjà sans accent
  }

  if (hasSearch) {
    parts.push(slug(searchPart));
  }

  if (hasChip) {
    parts.push(slug(chipPart));
  }

  // la date est toujours présente en dernier
  parts.push(dateStr);

  const baseName = parts.join("_");
  const fname = `${baseName}.xlsx`;

  XLSX.writeFile(wb, fname);
}

/* Export JPG pour Références */
async function refExportJpg() {
  if (!window.domtoimage) {
    alert("Bibliothèque dom-to-image absente");
    return;
  }

  // Utiliser la fonction générique d'export depuis app.js
  if (window.exportMapAsJpg) {
    await window.exportMapAsJpg(refMap, "references", refActiveCompanies, refCompanyColors, "refMap");
  } else {
    alert("Fonction d'export JPG non disponible");
  }
}


/* Bootstrap References module */
async function initReferences() {
  try {
    console.log("[Références] Initialisation...");
    
    // 1. Init map FIRST
    initRefMap();
    console.log("[Références] Carte initialisée");
    
    // 2. Load data
    references = await loadReferences();
    console.log("[Références] Données chargées:", references.length, "références");

    // 3. Setup UI
    const companies = refComputePalette(references);
    refDomainsByEntity = refComputeDomainsByEntity(references);
    refRenderCompanyChips(companies);
    refAddMarkers();
    refRenderList(references);
    refApplyFilters();

    // 4. Event listeners
    const refSearchInput = document.getElementById("refSearch");
    const refClearBtn = document.getElementById("refClear");
    const refFiltersResetBtn = document.getElementById("refFiltersReset");
    
    refSearchInput.addEventListener("input", refApplyFilters);
    refClearBtn.addEventListener("click", () => {
      refSearchInput.value = "";
      refApplyFilters();
    });
    
    // Bouton Réinitialiser
    if (refFiltersResetBtn) {
      refFiltersResetBtn.addEventListener("click", () => {
        refActiveDomains.clear();
        refRenderCompanyChips(companies);
        refSearchInput.value = "";
        refApplyFilters();
      });
    }

    // 5. Hook up Export buttons
    const refExportExcelBtn = document.getElementById("refExportExcel");
    if (refExportExcelBtn) {
      refExportExcelBtn.addEventListener("click", refExportExcel);
    }

    const refExportJpgBtn = document.getElementById("refExportJpg");
    if (refExportJpgBtn) {
      refExportJpgBtn.addEventListener("click", refExportJpg);
    }

    // 7. Setup toggle button
    const toggleBtn = document.getElementById("refPanelToggle");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        const collapsed = document.body.classList.toggle("ref-panel-collapsed");
        toggleBtn.textContent = collapsed ? "⟨" : "⟩";
      });
    }

    console.log("[Références] Initialisation terminée avec succès");
  } catch (e) {
    console.error("[Références] Erreur de chargement:", e);
    alert("Impossible de charger les données des références. Vérifiez l'URL du Google Sheet.");
  }
}

/* Export for global access */
window.initReferences = initReferences;
window.refMap = refMap;
