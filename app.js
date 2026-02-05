// NC Election Viewer Pro+
// Modes:
//  - Precompiled: loads data/precompiled/manifest.json + per-contest packs (fast, recommended)
//  - TSV: loads a TSV/TXT in-browser and builds aggregates once (slower but no preprocessing)

// Files
const PRECINCTS_URL = "./data/precincts.geojson";
const MANIFEST_URL  = "./data/precompiled/manifest.json";
const CONTEST_DIR   = "./data/precompiled/contests/";

// Map
let map, precinctLayer, precinctFeatures;

// In-memory aggregates (TSV mode)
let contestsTSV = [];
let precinctAggTSV = new Map();
let countyAggTSV = new Map();

// Precompiled cache
let manifest = null;
let contestCache = new Map(); // contestFile -> {precinctAgg, countyAgg, meta}

// UI
const elMode   = document.getElementById("mode");
const elTSVFile= document.getElementById("tsvFile");
const elScope  = document.getElementById("scope");
const elCounty = document.getElementById("county");
const elContest= document.getElementById("contest");
const elShade  = document.getElementById("shade");
const elJoin   = document.getElementById("joinField");
const elLines  = document.getElementById("toggleLines");
const elLoad   = document.getElementById("loadBtn");
const elReset  = document.getElementById("resetBtn");

const elSummary= document.getElementById("summary");
const elBoard  = document.getElementById("countyBoard");
const elHover  = document.getElementById("hover");
const elClick  = document.getElementById("click");

function norm(s){ return (s ?? "").toString().trim().toUpperCase(); }
function num(x){
  const n = Number((x ?? "").toString().replace(/,/g,""));
  return Number.isFinite(n) ? n : 0;
}
function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function partyColor(party){
  const p = norm(party);
  if (p === "REP") return "#b91c1c";
  if (p === "DEM") return "#1d4ed8";
  if (p === "UNA" || p === "UNAFFILIATED") return "#6b7280";
  if (p === "LIB") return "#f59e0b";
  if (p === "GRN") return "#16a34a";
  return "#a855f7";
}
function tint(hex, t){
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if(!m) return hex;
  const r = parseInt(m[1],16), g = parseInt(m[2],16), b = parseInt(m[3],16);
  const nr = Math.round(r + (255-r)*t);
  const ng = Math.round(g + (255-g)*t);
  const nb = Math.round(b + (255-b)*t);
  return "#" + [nr,ng,nb].map(v=>v.toString(16).padStart(2,"0")).join("");
}

function fillCountyDropdown(geojson){
  const set = new Set();
  for(const f of geojson.features){
    const c = norm(f.properties?.county_nam);
    if(c) set.add(c);
  }
  const counties = [...set].sort();
  elCounty.innerHTML = `<option value="">All counties</option>` + counties.map(c => `<option value="${c}">${c}</option>`).join("");
}

function parseTSV(text){
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if(!lines.length) return [];
  const header = lines[0].split("\t").map(h => h.trim());
  const rows = [];
  for(let i=1;i<lines.length;i++){
    const cols = lines[i].split("\t");
    const r = {};
    for(let c=0;c<header.length;c++){
      r[header[c]] = (cols[c] ?? "").trim();
    }
    rows.push(r);
  }
  return rows;
}

// Robust column getter: tries multiple names
function getCol(r, names){
  for(const n of names){
    if(r[n] !== undefined) return r[n];
  }
  return "";
}

// Scope mapping (best-effort)
function scopeCodeFromRow(r){
  const raw = getCol(r, ["contest_scope","contest_sc","contest_p","scope"]).toString().trim();
  const lower = raw.toLowerCase();
  if(lower.includes("state")) return "SW";
  if(lower.includes("county")) return "CO";
  if(raw === "3") return "CO";
  if(raw === "1") return "SW";
  return "OT";
}

// Build aggregates for TSV mode
function buildAggregatesTSV(rows){
  precinctAggTSV.clear();
  countyAggTSV.clear();

  const contestByKey = new Map();

  for(const r of rows){
    const county = norm(getCol(r, ["county","County"]));
    const precinctName = norm(getCol(r, ["precinct_name","precinct","Precinct","precinct_desc"]));
    const precinctCode = norm(getCol(r, ["precinct_code","precinct_cd","precinct_id"]));

    const contestId = norm(getCol(r, ["contest_id","contest","contestid"]));
    const title = (getCol(r, ["contest_title","contest_name","contest","Contest"]) ?? "").trim();

    const cand = (getCol(r, ["candidate","choice","Candidate"]) ?? "").trim();
    const party = (getCol(r, ["candidate_party","choice_party","party","Party"]) ?? "").trim();
    const votes = num(getCol(r, ["vote_ct","total votes","votes","Total Votes"]));

    if(!county || (!precinctName && !precinctCode) || !contestId || !title || !cand) continue;

    const scopeCode = scopeCodeFromRow(r);
    const contestKey = `${contestId}||${title}`;

    if(!contestByKey.has(contestKey)){
      contestByKey.set(contestKey, { key: contestKey, id: contestId, title, scopeCode, counties: new Set(), totalVotes: 0 });
    }
    const cobj = contestByKey.get(contestKey);
    cobj.counties.add(county);
    cobj.totalVotes += votes;

    const precinctKeyName = precinctName || precinctCode;
    const pkey = `${contestKey}|${county}|${precinctKeyName}`;

    let pobj = precinctAggTSV.get(pkey);
    if(!pobj){
      pobj = { total: 0, candVotes: new Map() };
      precinctAggTSV.set(pkey, pobj);
    }
    pobj.total += votes;

    const prev = pobj.candVotes.get(cand) || { votes: 0, party };
    prev.votes += votes;
    if(!prev.party && party) prev.party = party;
    pobj.candVotes.set(cand, prev);

    const ckey = `${contestKey}|${county}`;
    let cagg = countyAggTSV.get(ckey);
    if(!cagg){
      cagg = { total: 0, partyVotes: new Map() };
      countyAggTSV.set(ckey, cagg);
    }
    cagg.total += votes;
    if(party){
      cagg.partyVotes.set(party, (cagg.partyVotes.get(party) || 0) + votes);
    }
  }

  // finalize precinct winners/margins
  for(const [pkey, obj] of precinctAggTSV){
    let best = null;
    let second = 0;
    for(const [cand, v] of obj.candVotes){
      if(!best || v.votes > best.votes){
        if(best) second = Math.max(second, best.votes);
        best = { name: cand, party: v.party, votes: v.votes };
      } else {
        second = Math.max(second, v.votes);
      }
    }
    obj.winner = best;
    obj.runnerUpVotes = second;
    obj.marginPct = obj.total ? ((best.votes - second) / obj.total) : 0;
    delete obj.candVotes;
  }

  // finalize county winners
  for(const [ckey, obj] of countyAggTSV){
    let best = null;
    for(const [party, votes] of obj.partyVotes){
      if(!best || votes > best.votes) best = { party, votes };
    }
    obj.winnerParty = best ? best.party : "";
  }

  contestsTSV = [...contestByKey.values()];
}

// Precompiled loading
async function tryLoadManifest(){
  try{
    const res = await fetch(MANIFEST_URL, {cache:"no-store"});
    if(!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function contestsForMode(){
  if(elMode.value === "precompiled"){
    return manifest?.contests ?? [];
  }
  return contestsTSV;
}

function fillContestDropdown(){
  const scope = elScope.value;
  const county = elCounty.value;

  let list = contestsForMode();

  if(scope !== "ALL") list = list.filter(c => c.scopeCode === scope);
  if(county) list = list.filter(c => (c.counties || []).includes ? c.counties.includes(county) : (c.counties?.has?.(county)));

  // normalize for precompiled: counties is array
  list = list.slice().sort((a,b)=>a.title.localeCompare(b.title));

  elContest.innerHTML = list.map(c => `<option value="${c.key}">${c.title}</option>`).join("");
  if(list.length && !elContest.value) elContest.value = list[0].key;
}

async function getAggForSelectedContest(){
  const contestKey = elContest.value;
  if(!contestKey) return null;

  if(elMode.value === "tsv"){
    return { precinctAgg: precinctAggTSV, countyAgg: countyAggTSV, contest: contestsTSV.find(c=>c.key===contestKey) };
  }

  // precompiled
  const c = (manifest?.contests ?? []).find(x => x.key === contestKey);
  if(!c) return null;

  if(contestCache.has(c.file)) return contestCache.get(c.file);

  const res = await fetch(CONTEST_DIR + c.file, {cache:"force-cache"});
  if(!res.ok) return null;
  const pack = await res.json();

  // Convert to Maps for fast access
  const pMap = new Map(Object.entries(pack.precinctAgg || {}));
  const cMap = new Map(Object.entries(pack.countyAgg || {}));
  const out = { precinctAgg: pMap, countyAgg: cMap, contest: c };
  contestCache.set(c.file, out);
  return out;
}

function styleForFeatureFactory(active){
  return function(feature){
    const props = feature.properties || {};
    const county = norm(props.county_nam);
    const precinct = norm(props[elJoin.value]);
    const countyFilter = elCounty.value;
    const showLines = elLines.checked;

    if(countyFilter && county !== countyFilter){
      return { fillColor:"#111827", color: showLines ? "#334155" : "transparent", weight: showLines ? 0.2 : 0, fillOpacity:0.03, opacity:0.08 };
    }

    if(!active){
      return { fillColor:"#111827", color: showLines ? "#334155" : "transparent", weight: showLines ? 0.4 : 0, fillOpacity:0.18, opacity:0.35 };
    }

    const contestKey = elContest.value;
    const shade = elShade.value;
    const k = `${contestKey}|${county}|${precinct}`;
    const m = active.precinctAgg.get(k);

    if(!m || !m.winner){
      return { fillColor:"#111827", color: showLines ? "#334155" : "transparent", weight: showLines ? 0.35 : 0, fillOpacity:0.12, opacity:0.25 };
    }

    if(shade === "party"){
      const base = partyColor(m.winner.party);
      const turnoutFactor = clamp01((m.total || 0) / 1200);
      const tinted = tint(base, 0.55 - 0.35*turnoutFactor);
      return { fillColor:tinted, color: showLines ? "#0b1220" : "transparent", weight: showLines ? 0.6 : 0, fillOpacity:0.78, opacity:0.6 };
    }

    if(shade === "margin"){
      const base = partyColor(m.winner.party);
      const t = 0.75 - 0.65*clamp01(m.marginPct || 0);
      return { fillColor:tint(base, t), color: showLines ? "#0b1220" : "transparent", weight: showLines ? 0.6 : 0, fillOpacity:0.80, opacity:0.6 };
    }

    const turnout = clamp01((m.total || 0) / 1500);
    const ccol = tint("#22c55e", 0.85 - 0.7*turnout);
    return { fillColor:ccol, color: showLines ? "#0b1220" : "transparent", weight: showLines ? 0.6 : 0, fillOpacity:0.78, opacity:0.6 };
  }
}

function bindFeatureEvents(feature, layer){
  layer.on("mousemove", () => {
    const p = feature.properties || {};
    elHover.textContent =
      `County: ${(p.county_nam ?? "").toString()}\n` +
      `prec_id: ${(p.prec_id ?? "").toString()}\n` +
      `enr_desc: ${(p.enr_desc ?? "").toString()}`;
  });
  layer.on("mouseout", () => elHover.textContent = "—");

  layer.on("click", async () => {
    const active = await getAggForSelectedContest();
    const contestKey = elContest.value;
    if(!active || !contestKey){
      elClick.textContent = "Load a TSV or precompile contest packs first.";
      return;
    }

    const p = feature.properties || {};
    const county = norm(p.county_nam);
    const precinct = norm(p[elJoin.value]);
    const k = `${contestKey}|${county}|${precinct}`;
    const m = active.precinctAgg.get(k);

    if(!m || !m.winner){
      elClick.textContent = `No results matched.\nCounty: ${county}\nPrecinct: ${precinct}`;
      return;
    }

    const margin = ((m.marginPct || 0)*100).toFixed(1) + "%";
    elClick.textContent =
      `County: ${county}\n` +
      `Precinct: ${precinct}\n\n` +
      `Winner: ${m.winner.name}\n` +
      `Party: ${m.winner.party || "—"}\n` +
      `Votes: ${Math.round(m.winner.votes).toLocaleString()}\n` +
      `Total: ${Math.round(m.total || 0).toLocaleString()}\n` +
      `Margin: ${margin}`;
  });
}

async function updatePanels(active){
  const contestKey = elContest.value;
  const countyFilter = elCounty.value;

  if(!active || !contestKey){
    elSummary.textContent = (elMode.value === "precompiled")
      ? "Precompiled mode: run tools/precompile_statewide.py to generate packs."
      : "TSV mode: choose a TSV/TXT and click Load.";
    elBoard.textContent = "—";
    return;
  }

  const c = active.contest;
  const scopeLabel = c?.scopeCode === "SW" ? "Statewide" : (c?.scopeCode === "CO" ? "County" : "Other");

  let colored = 0, missing = 0, totalVotes = 0;

  // compute totalVotes via countyAgg entries (faster)
  for(const [k, v] of active.countyAgg){
    if(!k.startsWith(contestKey + "|")) continue;
    const kCounty = k.split("|")[1];
    if(countyFilter && kCounty !== countyFilter) continue;
    totalVotes += (v.total || 0);
  }

  precinctLayer.eachLayer(layer => {
    const props = layer.feature.properties || {};
    const lyrCounty = norm(props.county_nam);
    if(countyFilter && lyrCounty !== countyFilter) return;
    const precinct = norm(props[elJoin.value]);
    const k = `${contestKey}|${lyrCounty}|${precinct}`;
    const m = active.precinctAgg.get(k);
    if(m && m.winner) colored++; else missing++;
  });

  elSummary.textContent =
    `Contest: ${c?.title ?? "(unknown)"}\n` +
    `Scope: ${scopeLabel}\n` +
    `Mode: ${elMode.value}\n` +
    `County filter: ${countyFilter || "none"}\n` +
    `Join field: ${elJoin.value}\n` +
    `Mapped precincts: ${colored}\n` +
    `Missing precincts: ${missing}\n` +
    `Total votes (filtered): ${Math.round(totalVotes).toLocaleString()}`;

  // County scoreboard (top 12 by total votes)
  const rows = [];
  for(const [k, v] of active.countyAgg){
    if(!k.startsWith(contestKey + "|")) continue;
    const kCounty = k.split("|")[1];
    if(countyFilter && kCounty !== countyFilter) continue;
    rows.push({ county: kCounty, total: v.total || 0, winnerParty: v.winnerParty || "" });
  }
  rows.sort((a,b)=>b.total-a.total);

  elBoard.textContent = rows.slice(0,12).map(r => {
    const p = r.winnerParty ? norm(r.winnerParty) : "—";
    return `${r.county.padEnd(14)}  ${p.padEnd(4)}  ${Math.round(r.total).toLocaleString()}`;
  }).join("\n") || "—";
}

async function refresh(){
  const active = await getAggForSelectedContest();
  precinctLayer.setStyle(styleForFeatureFactory(active));
  await updatePanels(active);
}

async function init(){
  map = L.map("map", { preferCanvas:true }).setView([35.5, -79.4], 7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom:18,
    attribution:"&copy; OpenStreetMap"
  }).addTo(map);

  precinctFeatures = await (await fetch(PRECINCTS_URL)).json();
  fillCountyDropdown(precinctFeatures);

  precinctLayer = L.geoJSON(precinctFeatures, {
    style: styleForFeatureFactory(null),
    onEachFeature: bindFeatureEvents
  }).addTo(map);

  // precompiled manifest (optional)
  manifest = await tryLoadManifest();

  fillContestDropdown();
  await refresh();
}

// File read
function loadTextFromFile(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

function setModeUI(){
  const isTSV = elMode.value === "tsv";
  document.querySelectorAll(".fileOnly").forEach(el => el.style.display = isTSV ? "" : "none");
}
setModeUI();

elMode.addEventListener("change", async () => {
  setModeUI();
  fillContestDropdown();
  await refresh();
});

elLoad.addEventListener("click", async () => {
  if(elMode.value === "precompiled"){
    // reload manifest from disk (in case you just ran precompile)
    manifest = await tryLoadManifest();
    contestCache.clear();
    fillContestDropdown();
    await refresh();
    return;
  }

  const file = elTSVFile.files?.[0];
  if(!file){
    alert("Choose a TSV/TXT file first.");
    return;
  }

  elSummary.textContent = "Loading TSV and building aggregates…";
  try{
    const text = await loadTextFromFile(file);
    const rows = parseTSV(text);
    buildAggregatesTSV(rows);
    fillContestDropdown();
    await refresh();
  } catch (e){
    console.error(e);
    alert("Failed to load TSV. See console.");
  }
});

elReset.addEventListener("click", async () => {
  contestsTSV = [];
  precinctAggTSV.clear();
  countyAggTSV.clear();
  contestCache.clear();
  elContest.innerHTML = "";
  elScope.value = "ALL";
  elCounty.value = "";
  elShade.value = "party";
  elJoin.value = "join_enr_desc";
  await refresh();
});

elScope.addEventListener("change", async () => { fillContestDropdown(); await refresh(); });
elCounty.addEventListener("change", async () => { fillContestDropdown(); await refresh(); });
elContest.addEventListener("change", refresh);
elShade.addEventListener("change", refresh);
elJoin.addEventListener("change", refresh);
elLines.addEventListener("change", refresh);

init().catch(err => {
  console.error(err);
  elSummary.textContent = "Error loading precinct polygons. See console.";
});
