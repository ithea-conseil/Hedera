/* ===== Veille concurrentielle ===== */
const API_BASE = "https://veille-production.up.railway.app";

let veilleMap;           // carte Leaflet dédiée à la veille
let veilleLayer = null;  // calque points veille
let currentRows = [];    // lignes affichées
const MAP_MAX_DEFAULT = 500;

let veilleOMS = null;
let _veilleLastMapMax = MAP_MAX_DEFAULT;

function veilleJitterLatLng(baseLatLng, indexInGroup, groupSize){
  if (!veilleMap) return baseLatLng;
  const zoom = veilleMap.getZoom();
  // Amplitude en px (diminue quand on zoome un peu)
  const basePx = Math.max(0, Math.min(14, (10 + zoom) * 2 + 2));
  if (groupSize <= 1 || basePx === 0) return baseLatLng;

  // Anneaux de 6, 12, 18… positions (répartition hexagonale)
  let ring = 0, used = 0, cap = 6;
  while (indexInGroup >= used + cap){ used += cap; ring++; cap = 6 + ring * 6; }
  const idxInRing = indexInGroup - used;
  const slots = cap;

  const radiusPx = basePx * (ring + 1);
  const angle = (2 * Math.PI * idxInRing) / slots;

  const p  = veilleMap.latLngToLayerPoint(baseLatLng);
  const p2 = L.point(p.x + radiusPx * Math.cos(angle), p.y + radiusPx * Math.sin(angle));
  return veilleMap.layerPointToLatLng(p2);
}


/* UI */
const TAB_ANN     = document.querySelector('.tab-chip[data-tab="annuaire"]');
const TAB_REF     = document.querySelector('.tab-chip[data-tab="references"]');
const TAB_VEILLE  = document.querySelector('.tab-chip[data-tab="veille"]');

const MAP_ANNUAIRE = document.getElementById("map");
const PANEL        = document.getElementById("panel");
const PANEL_TOGGLE = document.getElementById("panelToggle");

const VEILLE_MAP   = document.getElementById("veilleMap");
const OVERLAY      = document.getElementById("veilleOverlay");
const V_SEARCH     = document.getElementById("veilleSearch");
const V_LIMIT      = document.getElementById("veilleLimit");
const V_GO         = document.getElementById("veilleGo");
const V_AWARD      = document.getElementById("awardeeInput");
const V_EXPORT     = document.getElementById("exportExcel");
const V_COUNT      = document.getElementById("veilleCount");
/* refs UI supplémentaires */
const V_SPIN = document.getElementById("veilleSpinner");

const VEILLE_PANEL = document.getElementById("veillePanel");
const V_TOGGLE     = document.getElementById("veillePanelToggle");

/* Cards container (remplace la table) */
const V_LIST  = document.getElementById("veilleList");
const V_EMPTY = document.getElementById("veilleEmpty");

/* Utils */
function escHTML(s){ return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function escAttr(s){ return escHTML(s).replace(/"/g,"&quot;"); }

function triggerAwardeeSearch(name){
  if (!name) return;
  if (V_SEARCH) V_SEARCH.value = "";
  // if (V_AWARD) V_AWARD.value = name; // optionnel si tu gardes le champ un jour
  runSearch({ awardee: name });
}


const qs = (obj)=>
  Object.entries(obj)
    .filter(([,v]) => v !== undefined && v !== null && v !== "")
    .map(([k,v]) => Array.isArray(v)
      ? v.map(x=>`${encodeURIComponent(k)}=${encodeURIComponent(x)}`).join("&")
      : `${encodeURIComponent(k)}=${encodeURIComponent(v)}` )
    .join("&");

function parseAwardees(text){
  return String(text||"")
    .split(",")
    .map(s=>s.trim())
    .filter(Boolean);
}

function ensureVeilleLayer(){
  if (!veilleMap) return;
  if (!veilleLayer){ veilleLayer = L.layerGroup().addTo(veilleMap); }
}

function clearVeille(){
  if (veilleLayer){ veilleLayer.clearLayers(); }
  currentRows = [];
  if (V_LIST) V_LIST.innerHTML = "";
  if (V_EMPTY) V_EMPTY.classList.add("hidden");
  V_COUNT.textContent = "Saisissez vos critères puis lancez la recherche.";
}

/* ---- Carte veille ---- */
function initVeilleMap(){
  if (veilleMap) return;                // ✅ une seule instanciation
  veilleMap = L.map("veilleMap", { zoomControl:false }).setView([46.71109, 1.7191036], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(veilleMap);
  L.control.zoom({position:"bottomleft"}).addTo(veilleMap);
  ensureVeilleLayer();

  if (!veilleOMS && window.OverlappingMarkerSpiderfier){
    veilleOMS = new OverlappingMarkerSpiderfier(veilleMap, {
      keepSpiderfied: true,
      nearbyDistance: 12,
      circleSpiralSwitchover: 12
    });
  }
  veilleMap.on('zoomend', ()=>{
    if (currentRows && currentRows.length){
      const limit = parseInt(V_LIMIT.value || "50", 10);
      const mapMax = Math.min(limit, MAP_MAX_DEFAULT, _veilleLastMapMax || MAP_MAX_DEFAULT);
      // AVANT : renderMap(currentRows, mapMax);
      renderMap(currentRows, mapMax, { preserveView:true });
    }
  });


  // if (!_popupLinkWired){
  //   veilleMap.on("popupopen", (e)=>{
  //     const root = e?.popup?.getElement();
  //     if (!root) return;
  //     root.querySelectorAll(".awardee-link").forEach(a=>{
  //       a.addEventListener("click", (ev)=>{
  //         ev.preventDefault();
  //         const name = (a.dataset.awardee || a.textContent || "").trim();
  //         runSearch({ awardee: name }); // seulement awardee + limit
  //         try { veilleMap.closePopup(); } catch(_) {}
  //       }, { once:false });
  //     });
  //   });
  //   _popupLinkWired = true;
  // }
}

function renderMap(rows, mapMax, opts = {}){
  const preserveView = !!opts.preserveView;
  ensureVeilleLayer();
  if (!veilleLayer) return;
  veilleLayer.clearLayers();

  _veilleLastMapMax = mapMax;

  // 1) Filtre + cap
  const pts = rows
    .slice(0, mapMax)
    .filter(r => Number.isFinite(+r.acheteur_latitude) && Number.isFinite(+r.acheteur_longitude));

  // 2) Groupes de coordonnées exactes (~1e-5°)
  const groups = new Map(); // key "lat,lon" -> [row, row, ...]
  for (const r of pts){
    const key = `${(+r.acheteur_latitude).toFixed(5)},${(+r.acheteur_longitude).toFixed(5)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const icon = () => L.divIcon({
    className: 'veille-marker',
    html: `<span style="display:block;width:18px;height:18px;border-radius:50%;background:#0ea5e9;
      box-shadow:0 0 0 2px rgba(255,255,255,.95) inset, 0 0 0 1px rgba(0,0,0,.45);"></span>`,
    iconSize:[18,18]
  });

  const fmtMoney = (v)=> (v==null ? "" : new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(+v));
  const fmtDate  = (d)=> (d ? new Date(d).toLocaleDateString('fr-FR') : "");

  const markers = [];

  // 3) Pour chaque groupe, on place les points en anneaux autour de la coordonnée de base
  for (const [key, arr] of groups){
    const [baseLat, baseLon] = key.split(',').map(Number);
    const base = L.latLng(baseLat, baseLon);

    arr.forEach((r, k)=>{
      const latlng = veilleJitterLatLng(base, k, arr.length);  // <-- décalage doux

      const buyerName = String(r.acheteur_nom || "").trim();
      const m = L.marker(latlng, { icon: icon(), riseOnHover:true });

      if (buyerName){
        m.bindTooltip(buyerName, {
          direction: 'top',
          offset: [0, -10],
          opacity: 0.95,
          sticky: true
        });
      }

      const objet = String(r.objet||"");
      const objShort = objet.length > 300 ? objet.slice(0,300) + "…" : objet;

      const html = `
        <div class="popup-veille">
          <div class="title">${r.acheteur_nom ?? ""}</div>
          <div class="subtitle">
            ${r.titulaire_nom
              ? `<a href="#" class="awardee-link" data-awardee="${escAttr(r.titulaire_nom)}" title="Filtrer sur ce titulaire">${escHTML(r.titulaire_nom)}</a>`
              : ""
            }
          </div>
          <div class="badges">
            ${r.procedure ? `<span class="v-badge">${r.procedure}</span>` : ""}
            ${r.acheteur_region_nom ? `<span class="v-badge">${r.acheteur_region_nom}</span>` : ""}
          </div>
          <div class="badges">
               ${r.montant ? `<span class="v-badge">${fmtMoney(r.montant)}</span>` : ""}
               ${r.dateNotification ? `<span class="v-badge">${fmtDate(r.dateNotification)}</span>` : ""}
          </div>
          ${objShort ? `<div class="v-obj" title="${objet.replace(/"/g,'&quot;')}">${objShort}</div>` : ""}
        </div>`;
      m.bindPopup(html, { className:'rich-popup', autoPan:true });

      veilleLayer.addLayer(m);
      if (veilleOMS) veilleOMS.addMarker(m);        // <-- spiderfy au clic
      markers.push(m);
    });
  }

  if (!preserveView && markers.length){
    try { 
      veilleMap.fitBounds(L.featureGroup(markers).getBounds().pad(0.2)); 
    } catch(e){}
  }
}

/* ---- Cartes (remplace la table/UID masqué) ---- */
function renderCards(rows){
  currentRows = rows;

  if (!rows.length){
    V_LIST.innerHTML = "";
    V_EMPTY.classList.remove("hidden");
    return;
  }
  V_EMPTY.classList.add("hidden");

  const fmtMoney = (v)=> (v==null ? "" : new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(+v));
  const fmtDate  = (d)=> (d ? new Date(d).toLocaleDateString('fr-FR') : "");

  V_LIST.innerHTML = rows.map(r => {
    const lat = r.acheteur_latitude ?? '';
    const lon = r.acheteur_longitude ?? '';
    const objet = String(r.objet||"");
    const objShort = objet.length > 300 ? objet.slice(0,300) + "…" : objet;

    return `
      <li class="v-card" data-lat="${lat}" data-lon="${lon}">
        <div class="title">${r.acheteur_nom ?? ""}</div>
        <div class="subtitle">
          ${r.titulaire_nom
            ? `<a href="#" class="awardee-link" data-awardee="${escAttr(r.titulaire_nom)}" title="Filtrer sur ce titulaire">${escHTML(r.titulaire_nom)}</a>`
            : ""
          }
        </div>
        <div class="badges">
          ${r.procedure ? `<span class="v-badge">${r.procedure}</span>` : ""}
          ${r.acheteur_region_nom ? `<span class="v-badge">${r.acheteur_region_nom}</span>` : ""}
        </div>

        <div class="v-kv">
          <div class="k">Montant</div><div class="v"><strong>${fmtMoney(r.montant)}</strong></div>
          <div class="k">Date</div><div class="v">${fmtDate(r.dateNotification)}</div>
        </div>

        ${objShort ? `<div class="v-obj" title="${objet.replace(/"/g,'&quot;')}">${objShort}</div>` : ""}
      </li>
    `;
  }).join("");


  // focus carte au clic
  Array.from(V_LIST.querySelectorAll(".v-card")).forEach(card=>{
    const go = ()=>{
      const lat = +card.dataset.lat, lon = +card.dataset.lon;
      if (Number.isFinite(lat) && Number.isFinite(lon) && veilleMap){
        veilleMap.flyTo([lat, lon], Math.max(veilleMap.getZoom(), 8), { duration:.5 });
      }
    };
    card.addEventListener("click", (e)=>{
      // évite double-clic quand on clique sur le bouton
      if (e.target && e.target.matches('[data-action="focus"]')) return;
      go();
    });
    const btn = card.querySelector('[data-action="focus"]');
    if (btn) btn.addEventListener("click", (e)=>{ e.stopPropagation(); go(); });
  });

  // Clic sur le titulaire dans la liste : ne pas déclencher le flyTo de la carte
  V_LIST.querySelectorAll(".awardee-link").forEach(a=>{
    a.addEventListener("click", (e)=>{
      e.preventDefault();
      e.stopPropagation(); // empêche le handler .v-card de se déclencher
      const name = (a.dataset.awardee || a.textContent || "").trim();
      runSearch({ awardee: name }); // relance avec seulement awardee + limit
    });
  });

}

/* ---- API (unique fetch pour carte + cards) ---- */
async function fetchRowsCombined({ q, awardees, limit }){
  const params = { limit: limit || 50 };
  if (q && q.trim()) params.q = q.trim();
  const aw = parseAwardees(awardees);
  if (aw.length) params.awardee = aw; // param multi

  const url = `${API_BASE}/rows?${qs(params)}`;
  const r = await fetch(url);
  if (!r.ok){
    const txt = await r.text();
    throw new Error(txt);
  }
  const data = await r.json(); // { total, limit, offset, rows }
  return data;
}

/* ---- Export ---- */
function exportExcel(){
  if (!window.XLSX){ alert("Bibliothèque XLSX absente"); return; }
  const ws = XLSX.utils.json_to_sheet(currentRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Marchés");
  const fname = `marches_filtres_${new Date().toISOString().slice(0,10)}.xlsx`;
  XLSX.writeFile(wb, fname);
}

/* ---- Flux “Rechercher” ---- */
async function runSearch(opts = {}){
  const override = opts.awardee && String(opts.awardee).trim();

  // Si on clique sur un titulaire : on ignore q
  const q = override ? "" : (V_SEARCH ? (V_SEARCH.value || "") : "");

  // awardee depuis l’override (clic) ou depuis le champ (s’il existe encore)
  const awardees = override || (V_AWARD ? (V_AWARD.value || "") : "");

  const limit = parseInt(V_LIMIT.value || "50", 10);
  const mapMax = Math.min(limit, MAP_MAX_DEFAULT);

  V_COUNT.textContent = "Chargement…";
  if (V_SPIN) V_SPIN.classList.remove("hidden");

  try{
    const data = await fetchRowsCombined({ q, awardees, limit });
    const rows = Array.isArray(data.rows) ? data.rows : [];

    const total = Number.isFinite(+data.total) ? +data.total : rows.length;
    const shown = Math.min(limit, total, rows.length);
    V_COUNT.textContent = `${total.toLocaleString('fr-FR')} résultats (affichage des ${rows.length.toLocaleString('fr-FR')} premiers)`;

    renderCards(rows);
    renderMap(rows, mapMax);
  }catch(e){
    console.error("[Veille] runSearch error:", e);
    V_COUNT.textContent = "Erreur de chargement";
    clearVeille();
  } finally {
    if (V_SPIN) V_SPIN.classList.add("hidden");
  }
}

/* ---- Navigation onglets : masquer/afficher éléments Annuaire ---- */
function switchToVeille(){
  // cacher Annuaire
  if (PANEL)        PANEL.classList.add("hidden");
  if (PANEL_TOGGLE) PANEL_TOGGLE.classList.add("hidden");
  if (MAP_ANNUAIRE) MAP_ANNUAIRE.classList.add("hidden");

  // montrer Veille
  VEILLE_MAP.classList.remove("hidden");
  OVERLAY.classList.remove("hidden");
  VEILLE_PANEL.classList.remove("hidden");

  initVeilleMap();
  setTimeout(() => { try { veilleMap.invalidateSize(); } catch(e){} }, 30);

  // clearVeille(); // carte vide tant que pas “Rechercher”
}

function switchToAnnuaireOrRefs(){
  // ré-afficher Annuaire
  if (PANEL)        PANEL.classList.remove("hidden");
  if (PANEL_TOGGLE) PANEL_TOGGLE.classList.remove("hidden");
  if (MAP_ANNUAIRE) MAP_ANNUAIRE.classList.remove("hidden");

  // masquer Veille
  VEILLE_MAP.classList.add("hidden");
  OVERLAY.classList.add("hidden");
  VEILLE_PANEL.classList.add("hidden");

  setTimeout(() => {
    try { if (window.map && window.map.invalidateSize) window.map.invalidateSize(); } catch(e){}
  }, 30);
}

function initVeille(){
  if (!TAB_VEILLE) return;

  TAB_VEILLE.addEventListener("click", switchToVeille);
  if (TAB_ANN) TAB_ANN.addEventListener("click", switchToAnnuaireOrRefs);
  if (TAB_REF) TAB_REF.addEventListener("click", switchToAnnuaireOrRefs);

  V_GO.addEventListener("click", runSearch);
  V_EXPORT.addEventListener("click", exportExcel);

  // Enter ↵ déclenche la recherche depuis q ET awardee
  const handleEnter = (e)=>{ if (e.key === "Enter") runSearch(); };
  V_SEARCH.addEventListener("keydown", handleEnter);
  if (V_AWARD) V_AWARD.addEventListener("keydown", handleEnter);


  if (V_TOGGLE){
    V_TOGGLE.addEventListener("click", ()=>{
      const collapsed = document.body.classList.toggle("veille-collapsed");
      V_TOGGLE.textContent = collapsed ? "⟨" : "⟩";
      V_TOGGLE.setAttribute("aria-expanded", String(!collapsed));
    });
  }
  // Délégation globale : clic sur un nom de titulaire => relance la recherche
  document.addEventListener("click", (e) => {
    const el = e.target.closest(".awardee-link");
    if (!el) return;
    e.preventDefault();
    e.stopPropagation(); // évite le flyTo de la carte quand on clique dans une carte
    const name = (el.dataset.awardee || el.textContent || "").trim();
    triggerAwardeeSearch(name);
  });

}

document.addEventListener("DOMContentLoaded", initVeille);
