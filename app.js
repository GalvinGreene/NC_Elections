// NC Election Viewer Pro+
// Modes:
//  - Precompiled: loads data/precompiled/manifest.json + per-contest packs (fast, recommended)
//  - TSV: loads a TSV/TXT in-browser and builds aggregates once (slower but no preprocessing)

// Files
const PRECINCTS_URL = "./data/precincts.geojson";
const PRECINCT_CRS = "+proj=lcc +lat_1=34.33333333333334 +lat_2=36.16666666666666 +lat_0=33.75 +lon_0=-79 +x_0=609601.2192024384 +y_0=0 +ellps=GRS80 +datum=NAD83 +units=us-ft +no_defs";
const MANIFEST_URL  = "./data/precompiled/manifest.json";
const CONTEST_DIR   = "./data/precompiled/contests/";

// Map
let map, precinctLayer, precinctFeatures;
let baseLayer;

// In-memory aggregates (TSV mode)
let contestsTSV = [];
let precinctAggTSV = new Map();
let precinctLookupTSV = new Map();
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
const elMapTarget = document.getElementById("mapTarget");
const elFolderSelect = document.getElementById("folderSelect");
const elShade  = document.getElementById("shade");
const elJoin   = document.getElementById("joinField");
const elSyncNames = document.getElementById("syncPrecinctNames");
const elLines  = document.getElementById("toggleLines");
const elLineWeight = document.getElementById("lineWeight");
const elLineWeightValue = document.getElementById("lineWeightValue");
const elLayerOpacity = document.getElementById("layerOpacity");
const elLayerOpacityValue = document.getElementById("layerOpacityValue");
const elToggleBasemap = document.getElementById("toggleBasemap");
const elLoad   = document.getElementById("loadBtn");
const elReset  = document.getElementById("resetBtn");
const elDownload = document.getElementById("downloadBtn");
const elSaveRawBtn = document.getElementById("saveRawBtn");

const elSummary= document.getElementById("summary");
const elBoard  = document.getElementById("countyBoard");
const elHover  = document.getElementById("hover");
const elClick  = document.getElementById("click");
const elVoteCounty = document.getElementById("voteCounty");
const elVotePrecinct = document.getElementById("votePrecinct");
const elMismatchSummary = document.getElementById("mismatchSummary");
const elMismatchList = document.getElementById("mismatchList");
const elApplyMismatchBtn = document.getElementById("applyMismatchBtn");
const elContestSearch = document.getElementById("contestSearch");
const elContestList = document.getElementById("contestList");
const elContestCount = document.getElementById("contestCount");
const elSelectAllBtn = document.getElementById("selectAllBtn");
const elClearSelectBtn = document.getElementById("clearSelectBtn");
const elFolderName = document.getElementById("folderName");
const elAddFolderBtn = document.getElementById("addFolderBtn");
const elAssignFolderBtn = document.getElementById("assignFolderBtn");
const elExportFolderBtn = document.getElementById("exportFolderBtn");
const elRemoveFolderBtn = document.getElementById("removeFolderBtn");
const elFolderSummary = document.getElementById("folderSummary");
const colorInputs = Array.from(document.querySelectorAll("input[type='color'][data-color-scope]"));

const STATEWIDE_TSV_URL = "https://s3.amazonaws.com/dl.ncsbe.gov/ENRS/2024_11_05/results_precinct_sort/STATEWIDE_PRECINCT_SORT.txt";

const folderStore = {
  load(){
    try{
      const raw = localStorage.getItem("contestFolders");
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  },
  save(folders){
    localStorage.setItem("contestFolders", JSON.stringify(folders));
  }
};
let folders = folderStore.load();

const selectedContestKeys = new Set();
let filteredContestKeys = [];
let rawTSVText = "";
let rawTSVHeader = [];
let rawTSVContestIndex = -1;
let lastNameSync = null;
let hoverContext = null;
let lastActiveAgg = null;
let tsvNameMismatches = [];

function norm(s){ return (s ?? "").toString().trim().toUpperCase(); }
function normalizeHeader(s){
  return (s ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
function num(x){
  const n = Number((x ?? "").toString().replace(/,/g,""));
  return Number.isFinite(n) ? n : 0;
}
function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function getFirstCoordinate(geojson){
  for(const feature of geojson.features || []){
    const coords = feature?.geometry?.coordinates;
    if(!coords) continue;
    let node = coords;
    while(Array.isArray(node) && Array.isArray(node[0])){
      node = node[0];
    }
    if(Array.isArray(node) && typeof node[0] === "number"){
      return node;
    }
  }
  return null;
}

function joinValueFromFeature(props){
  if(elJoin.value === "join_prec_id") return props?.prec_id;
  return props?.enr_desc;
}

function resolvePrecinctAgg(active, key){
  if(active?.precinctLookup?.has(key)) return active.precinctLookup.get(key);
  return active?.precinctAgg?.get(key);
}

function candidateEntriesFromAgg(agg){
  if(!agg?.candVotes) return [];
  if(agg.candVotes instanceof Map){
    return [...agg.candVotes.entries()].map(([name, data]) => ({ name, ...data }));
  }
  return Object.entries(agg.candVotes).map(([name, data]) => ({ name, ...data }));
}

function formatCandidateTotals(agg, label, emptyMessage){
  if(!agg) return `${label}\n${emptyMessage || "No results matched."}`;
  const entries = candidateEntriesFromAgg(agg);
  if(!entries.length){
    return `${label}\nCandidate totals unavailable.`;
  }
  entries.sort((a,b)=> (b.votes || 0) - (a.votes || 0) || a.name.localeCompare(b.name));
  const total = Math.round(agg.total || entries.reduce((sum, e) => sum + (e.votes || 0), 0));
  const lines = entries.map(e => {
    const party = e.party ? ` (${e.party})` : "";
    const labelText = `${e.name}${party}`.slice(0, 30).padEnd(30);
    return `${labelText} ${Math.round(e.votes || 0).toLocaleString()}`;
  });
  return `${label}\nTotal: ${total.toLocaleString()}\n${lines.join("\n")}`;
}

function updateVoteTotals(active){
  if(!elVoteCounty || !elVotePrecinct) return;
  if(!active){
    elVoteCounty.textContent = "County totals appear here.";
    elVotePrecinct.textContent = "Precinct totals appear here.";
    return;
  }

  if(active.isFolder || active.usesCombinedKeys){
    elVoteCounty.textContent = "County totals unavailable in folder view.";
    elVotePrecinct.textContent = "Precinct totals unavailable in folder view.";
    return;
  }

  const contestKey = elContest.value;
  const countyTarget = elCounty.value || hoverContext?.county;
  const countyLabel = elCounty.value || hoverContext?.countyLabel || "—";

  if(!countyTarget){
    elVoteCounty.textContent = "County totals: hover a precinct or select a county.";
  } else {
    const countyKey = active.usesCombinedKeys ? countyTarget : `${contestKey}|${countyTarget}`;
    const countyAgg = active.countyAgg.get(countyKey);
    elVoteCounty.textContent = formatCandidateTotals(
      countyAgg,
      `County: ${countyLabel}`,
      "No county results matched."
    );
  }

  if(!hoverContext){
    elVotePrecinct.textContent = "Precinct totals: hover a precinct.";
  } else {
    const precinctKey = active.usesCombinedKeys
      ? `${hoverContext.county}|${hoverContext.precinct}`
      : `${contestKey}|${hoverContext.county}|${hoverContext.precinct}`;
    const precinctAgg = resolvePrecinctAgg(active, precinctKey);
    elVotePrecinct.textContent = formatCandidateTotals(
      precinctAgg,
      `Precinct: ${hoverContext.precinctLabel}`,
      "No precinct results matched."
    );
  }
}

function buildGeojsonPrecinctIndex(){
  if(!precinctFeatures?.features?.length) return new Map();
  const byKey = new Map();
  for(const feature of precinctFeatures.features){
    const props = feature.properties || {};
    const county = norm(props.county_nam);
    const precId = norm(props.prec_id);
    if(!county || !precId) continue;
    const key = `${county}|${precId}`;
    if(!byKey.has(key)){
      byKey.set(key, {
        feature,
        geoName: (props.enr_desc ?? "").toString()
      });
    }
  }
  return byKey;
}

function computeTSVNameMismatches(rows){
  const geoIndex = buildGeojsonPrecinctIndex();
  if(!geoIndex.size) return [];
  const seen = new Set();
  const mismatches = [];
  for(const r of rows){
    const county = norm(getCol(r, ["county","County"]));
    const precinctCode = norm(getCol(r, ["precinct_code","precinct_cd","precinct_id"]));
    const precinctName = (getCol(r, ["precinct_name","precinct","Precinct","precinct_desc"]) ?? "").trim();
    if(!county || !precinctCode || !precinctName) continue;
    const key = `${county}|${precinctCode}`;
    if(seen.has(key)) continue;
    seen.add(key);
    const geoEntry = geoIndex.get(key);
    if(!geoEntry) continue;
    const geoName = geoEntry.geoName;
    if(norm(geoName) !== norm(precinctName)){
      mismatches.push({
        county,
        precId: precinctCode,
        geoName,
        tsvName: precinctName,
        feature: geoEntry.feature
      });
    }
  }
  return mismatches.sort((a,b) => a.county.localeCompare(b.county) || a.precId.localeCompare(b.precId));
}

function renderMismatchPanel(){
  if(!elMismatchSummary || !elMismatchList || !elApplyMismatchBtn) return;
  if(!rawTSVText){
    elMismatchSummary.textContent = "Load a TSV to review unmatched precinct IDs.";
    elMismatchList.innerHTML = "";
    elApplyMismatchBtn.disabled = true;
    return;
  }
  if(!tsvNameMismatches.length){
    elMismatchSummary.textContent = "No unmatched precinct IDs found.";
    elMismatchList.innerHTML = "";
    elApplyMismatchBtn.disabled = true;
    return;
  }
  elMismatchSummary.textContent = `${tsvNameMismatches.length} precinct IDs with name mismatches (TSV vs GeoJSON).`;
  elApplyMismatchBtn.disabled = false;
  elMismatchList.innerHTML = tsvNameMismatches.map((m, idx) => `
    <div class="mismatchRow">
      <div class="mismatchMeta">
        <div><b>${m.county}</b> · Precinct ID ${m.precId}</div>
        <div class="small">Enter the correct precinct name to apply.</div>
      </div>
      <input type="text" data-mismatch-index="${idx}" value="${m.tsvName}" />
    </div>
  `).join("");
}

function applyMismatchUpdates(){
  if(!tsvNameMismatches.length) return;
  const inputs = elMismatchList.querySelectorAll("input[data-mismatch-index]");
  let updated = 0;
  inputs.forEach(input => {
    const idx = Number(input.dataset.mismatchIndex);
    if(!Number.isInteger(idx)) return;
    const entry = tsvNameMismatches[idx];
    if(!entry?.feature) return;
    const nextName = (input.value || "").trim();
    if(!nextName) return;
    const props = entry.feature.properties || {};
    if(norm(props.enr_desc) !== norm(nextName)){
      props.enr_desc = nextName;
      updated += 1;
    }
  });
  if(updated){
    tsvNameMismatches = computeTSVNameMismatches(parseTSV(rawTSVText));
    renderMismatchPanel();
    refresh();
  }
}

function reprojectCoordinates(coords, transform){
  if(typeof coords[0] === "number"){
    const input = coords.length > 2 ? coords.slice(0,2) : coords;
    const projected = transform(input);
    const [lon, lat] = Array.isArray(projected) ? projected : input;
    return [lon, lat];
  }
  return coords.map(coord => reprojectCoordinates(coord, transform));
}

function reprojectGeoJSON(geojson, transform){
  return {
    ...geojson,
    features: geojson.features.map(feature => ({
      ...feature,
      geometry: {
        ...feature.geometry,
        coordinates: reprojectCoordinates(feature.geometry.coordinates, transform)
      }
    }))
  };
}

const DEFAULT_COLOR_CONFIG = {
  parties: {
    REP: "#b91c1c",
    DEM: "#1d4ed8",
    UNA: "#6b7280",
    LIB: "#f59e0b",
    GRN: "#16a34a",
    OTHER: "#a855f7"
  },
  options: {
    YES: "#16a34a",
    NO: "#dc2626",
    FOR: "#16a34a",
    AGAINST: "#dc2626"
  }
};

function loadColorConfig(){
  try{
    const raw = localStorage.getItem("colorConfig");
    if(!raw) return structuredClone(DEFAULT_COLOR_CONFIG);
    const parsed = JSON.parse(raw);
    return {
      parties: { ...DEFAULT_COLOR_CONFIG.parties, ...(parsed.parties || {}) },
      options: { ...DEFAULT_COLOR_CONFIG.options, ...(parsed.options || {}) }
    };
  } catch {
    return structuredClone(DEFAULT_COLOR_CONFIG);
  }
}

function saveColorConfig(config){
  localStorage.setItem("colorConfig", JSON.stringify(config));
}

let colorConfig = loadColorConfig();

function partyColor(party){
  const p = norm(party);
  if (p === "REP") return colorConfig.parties.REP;
  if (p === "DEM") return colorConfig.parties.DEM;
  if (p === "UNA" || p === "UNAFFILIATED") return colorConfig.parties.UNA;
  if (p === "LIB") return colorConfig.parties.LIB;
  if (p === "GRN") return colorConfig.parties.GRN;
  return colorConfig.parties.OTHER;
}

function optionKeyFromCandidate(candidate){
  const n = norm(candidate);
  if(n === "FOR") return "FOR";
  if(n === "AGAINST") return "AGAINST";
  if(["YES","Y","APPROVE","APPROVED","FOR APPROVAL"].includes(n)) return "YES";
  if(["NO","N","REJECT","REJECTED","AGAINST APPROVAL"].includes(n)) return "NO";
  return "";
}

function winnerColor(winner){
  if(!winner) return colorConfig.parties.OTHER;
  const optionKey = optionKeyFromCandidate(winner.name);
  if(optionKey && colorConfig.options[optionKey]){
    return colorConfig.options[optionKey];
  }
  return partyColor(winner.party);
}

const NON_VOTE_CHOICES = new Set(["OVER VOTE", "UNDER VOTE"]);

function isNonVoteCandidate(candidate){
  return NON_VOTE_CHOICES.has(norm(candidate));
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
  const normalized = header.map(h => normalizeHeader(h));
  const rows = [];
  for(let i=1;i<lines.length;i++){
    const cols = lines[i].split("\t");
    const r = {};
    for(let c=0;c<header.length;c++){
      r[header[c]] = (cols[c] ?? "").trim();
      if(normalized[c]){
        r[normalized[c]] = (cols[c] ?? "").trim();
      }
    }
    rows.push(r);
  }
  return rows;
}

function parseTSVHeader(text){
  const firstLine = text.split(/\r?\n/).find(l => l.trim().length);
  if(!firstLine) return [];
  return firstLine.split("\t").map(h => h.trim());
}

function rememberRawTSV(text){
  rawTSVText = text;
  rawTSVHeader = parseTSVHeader(text);
  const normalized = rawTSVHeader.map(h => normalizeHeader(h));
  rawTSVContestIndex = normalized.findIndex(h => h === "contest_title");
  elSaveRawBtn.disabled = !rawTSVText;
}

function downloadTextFile(name, text){
  const blob = new Blob([text], {type: "text/plain"});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Robust column getter: tries multiple names
function getCol(r, names){
  for(const n of names){
    if(r[n] !== undefined) return r[n];
    const normalized = normalizeHeader(n);
    if(normalized && r[normalized] !== undefined) return r[normalized];
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

function scopeCodeFromSet(scopes){
  if(scopes.has("CO")) return "CO";
  if(scopes.has("SW")) return "SW";
  return "OT";
}

// Build aggregates for TSV mode
function buildAggregatesTSV(rows){
  precinctAggTSV.clear();
  precinctLookupTSV.clear();
  countyAggTSV.clear();

  const contestByKey = new Map();

  for(const r of rows){
    const county = norm(getCol(r, ["county","County"]));
    const precinctName = norm(getCol(r, ["precinct_name","precinct","Precinct","precinct_desc"]));
    const precinctCode = norm(getCol(r, ["precinct_code","precinct_cd","precinct_id"]));

    const title = (getCol(r, ["contest_title","contest_name","contest","Contest"]) ?? "").trim();
    const titleKey = norm(title);

    const cand = (getCol(r, ["candidate","candidate_name","choice","Candidate"]) ?? "").trim();
    const party = (getCol(r, ["candidate_party","candidate_party_lbl","choice_party","party","Party"]) ?? "").trim();
    const votes = num(getCol(r, ["vote_ct","total votes","votes","Total Votes"]));

    if(!county || (!precinctName && !precinctCode) || !titleKey || !cand) continue;
    if(isNonVoteCandidate(cand)) continue;

    const scopeCode = scopeCodeFromRow(r);
    const contestKey = titleKey;

    if(!contestByKey.has(contestKey)){
      contestByKey.set(contestKey, { key: contestKey, title, scopes: new Set(), counties: new Set(), totalVotes: 0 });
    }
    const cobj = contestByKey.get(contestKey);
    cobj.scopes.add(scopeCode);
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

    const aliasKeys = new Set([precinctName, precinctCode].filter(Boolean));
    for(const alias of aliasKeys){
      const aliasKey = `${contestKey}|${county}|${alias}`;
      precinctLookupTSV.set(aliasKey, pobj);
    }

    const ckey = `${contestKey}|${county}`;
    let cagg = countyAggTSV.get(ckey);
    if(!cagg){
      cagg = { total: 0, partyVotes: new Map(), candVotes: new Map() };
      countyAggTSV.set(ckey, cagg);
    }
    cagg.total += votes;
    if(party){
      cagg.partyVotes.set(party, (cagg.partyVotes.get(party) || 0) + votes);
    }
    const prevCand = cagg.candVotes.get(cand) || { votes: 0, party };
    prevCand.votes += votes;
    if(!prevCand.party && party) prevCand.party = party;
    cagg.candVotes.set(cand, prevCand);
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
  }

  // finalize county winners
  for(const [ckey, obj] of countyAggTSV){
    let best = null;
    for(const [party, votes] of obj.partyVotes){
      if(!best || votes > best.votes) best = { party, votes };
    }
    obj.winnerParty = best ? best.party : "";
  }

  contestsTSV = [...contestByKey.values()].map(c => ({
    key: c.key,
    title: c.title,
    scopeCode: scopeCodeFromSet(c.scopes),
    counties: c.counties,
    totalVotes: c.totalVotes
  }));
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
    return mergeContestsByTitle(manifest?.contests ?? []);
  }
  return contestsTSV;
}

function mergeContestsByTitle(contests){
  const byTitle = new Map();
  for(const contest of contests){
    const title = (contest.title ?? "").trim();
    if(!title) continue;
    const titleKey = norm(title);
    if(!byTitle.has(titleKey)){
      byTitle.set(titleKey, {
        title,
        key: contest.key,
        scopes: new Set([contest.scopeCode]),
        counties: new Set(contest.counties || []),
        totalVotes: contest.totalVotes || 0,
        contestKeys: [contest.key],
        original: contest
      });
    } else {
      const entry = byTitle.get(titleKey);
      entry.contestKeys.push(contest.key);
      entry.scopes.add(contest.scopeCode);
      (contest.counties || []).forEach(c => entry.counties.add(c));
      entry.totalVotes += contest.totalVotes || 0;
    }
  }

  const merged = [];
  for(const entry of byTitle.values()){
    if(entry.contestKeys.length === 1){
      merged.push(entry.original);
    } else {
      merged.push({
        title: entry.title,
        key: `merged::${norm(entry.title)}`,
        scopeCode: scopeCodeFromSet(entry.scopes),
        counties: Array.from(entry.counties),
        totalVotes: entry.totalVotes,
        contestKeys: entry.contestKeys.slice()
      });
    }
  }
  return merged;
}

function getContestByKey(key){
  return contestsForMode().find(c => c.key === key);
}

function getContestKeysForMap(){
  if(elMapTarget.value === "folder"){
    const folderName = elFolderSelect.value;
    const list = folders[folderName] || [];
    return list.slice();
  }
  return elContest.value ? [elContest.value] : [];
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
  renderContestLibrary();
}

function scopeLabelFor(code){
  if(code === "SW") return "Statewide";
  if(code === "CO") return "County";
  return "Other";
}

function renderContestLibrary(){
  const list = contestsForMode().slice().sort((a,b)=>a.title.localeCompare(b.title));
  const query = (elContestSearch.value || "").trim().toLowerCase();
  const filtered = query ? list.filter(c => c.title.toLowerCase().includes(query)) : list;
  filteredContestKeys = filtered.map(c => c.key);

  elContestCount.textContent = `${filtered.length} of ${list.length} contests`;
  elContestList.innerHTML = filtered.map(c => {
    const checked = selectedContestKeys.has(c.key) ? "checked" : "";
    return `
      <label class="contestItem">
        <input type="checkbox" data-key="${c.key}" ${checked} />
        <div>
          <div>${c.title}</div>
          <div class="pill">${scopeLabelFor(c.scopeCode)}</div>
        </div>
      </label>
    `;
  }).join("") || `<div class="small">No contests loaded yet.</div>`;
}

function renderFolderSelect(){
  const names = Object.keys(folders).sort();
  if(!names.length){
    elFolderSelect.innerHTML = `<option value="">No folders</option>`;
    elFolderSelect.disabled = true;
    elExportFolderBtn.disabled = true;
  } else {
    const current = elFolderSelect.value;
    elFolderSelect.innerHTML = names.map(n => `<option value="${n}">${n}</option>`).join("");
    if(names.includes(current)) elFolderSelect.value = current;
    else elFolderSelect.value = names[0];
    elFolderSelect.disabled = elMapTarget.value !== "folder";
    elExportFolderBtn.disabled = !rawTSVText;
  }
  updateFolderSummary();
}

function updateFolderSummary(){
  const names = Object.keys(folders);
  if(!names.length){
    elFolderSummary.textContent = "No folders yet. Create one to group contests.";
    return;
  }
  const activeName = elFolderSelect.value || names[0];
  const contests = folders[activeName] || [];
  elFolderSummary.textContent = `${names.length} folders. "${activeName}" contains ${contests.length} contests.`;
}

async function getAggForSelectedContest(){
  const contestKey = elContest.value;
  if(!contestKey) return null;
  return getAggForContestKey(contestKey);
}

async function getAggForContestKey(contestKey){
  if(!contestKey) return null;

  const contestEntry = getContestByKey(contestKey);
  if(contestEntry?.contestKeys?.length > 1){
    return await getAggForContestKeys(contestEntry.contestKeys, {
      contestInfo: {
        title: contestEntry.title,
        key: contestEntry.key,
        scopeCode: contestEntry.scopeCode,
        totalVotes: contestEntry.totalVotes
      },
      isFolder: false
    });
  }

  return getAggForContestKeyRaw(contestKey, contestEntry);
}

async function getAggForContestKeyRaw(contestKey, contestEntry){
  if(elMode.value === "tsv"){
    return {
      precinctAgg: precinctAggTSV,
      precinctLookup: precinctLookupTSV,
      countyAgg: countyAggTSV,
      contest: contestEntry || contestsTSV.find(c => c.key === contestKey),
      isFolder: false,
      usesCombinedKeys: false,
      contestKey
    };
  }

  // precompiled
  const c = contestEntry || (manifest?.contests ?? []).find(x => x.key === contestKey);
  if(!c) return null;

  if(contestCache.has(c.file)) return contestCache.get(c.file);

  const res = await fetch(CONTEST_DIR + c.file, {cache:"force-cache"});
  if(!res.ok) return null;
  const pack = await res.json();

  // Convert to Maps for fast access
  const pMap = new Map(Object.entries(pack.precinctAgg || {}).map(([key, value]) => {
    if(value?.candVotes){
      value.candVotes = new Map(Object.entries(value.candVotes));
    }
    return [key, value];
  }));
  const pLookup = pack.precinctLookup
    ? new Map(Object.entries(pack.precinctLookup || {}).map(([alias, canonical]) => [alias, pMap.get(canonical)]))
    : pMap;
  const cMap = new Map(Object.entries(pack.countyAgg || {}).map(([key, value]) => {
    if(value?.candVotes){
      value.candVotes = new Map(Object.entries(value.candVotes));
    }
    return [key, value];
  }));
  const out = { precinctAgg: pMap, precinctLookup: pLookup, countyAgg: cMap, contest: c, isFolder: false, usesCombinedKeys: false, contestKey };
  contestCache.set(c.file, out);
  return out;
}

async function getAggForContestKeys(contestKeys, options = {}){
  if(!contestKeys.length) return null;
  const combinedPrecinct = new Map();
  const combinedCounty = new Map();
  let totalVotes = 0;
  const contests = [];
  const fetchAgg = options.fetchAgg || getAggForContestKeyRaw;
  const expandedKeys = [];

  for(const key of contestKeys){
    const entry = getContestByKey(key);
    if(entry?.contestKeys?.length > 1){
      expandedKeys.push(...entry.contestKeys);
    } else {
      expandedKeys.push(key);
    }
  }

  for(const key of expandedKeys){
    const agg = await fetchAgg(key);
    if(!agg) continue;
    contests.push(agg.contest);
    totalVotes += agg.contest?.totalVotes || 0;

    for(const [pkey, val] of agg.precinctAgg){
      if(agg.contestKey && !pkey.startsWith(agg.contestKey + "|")) continue;
      const parts = pkey.split("|");
      const county = parts[1];
      const precinct = parts.slice(2).join("|");
      const combinedKey = `${county}|${precinct}`;
      const prev = combinedPrecinct.get(combinedKey) || { total: 0, partyVotes: new Map() };
      prev.total += val.total || 0;
      const party = val.winner?.party || "";
      if(party){
        prev.partyVotes.set(party, (prev.partyVotes.get(party) || 0) + (val.total || 0));
      }
      combinedPrecinct.set(combinedKey, prev);
    }

    for(const [ckey, val] of agg.countyAgg){
      if(agg.contestKey && !ckey.startsWith(agg.contestKey + "|")) continue;
      const county = ckey.split("|")[1];
      const prev = combinedCounty.get(county) || { total: 0, partyVotes: new Map() };
      prev.total += val.total || 0;
      const party = val.winnerParty || "";
      if(party){
        prev.partyVotes.set(party, (prev.partyVotes.get(party) || 0) + (val.total || 0));
      }
      combinedCounty.set(county, prev);
    }
  }

  for(const [pkey, obj] of combinedPrecinct){
    let bestParty = "";
    let bestVotes = -1;
    let secondVotes = 0;
    for(const [party, votes] of obj.partyVotes){
      if(votes > bestVotes){
        secondVotes = Math.max(secondVotes, bestVotes);
        bestVotes = votes;
        bestParty = party;
      } else {
        secondVotes = Math.max(secondVotes, votes);
      }
    }
    const marginPct = obj.total ? (bestVotes - secondVotes) / obj.total : 0;
    obj.winner = { party: bestParty, votes: bestVotes };
    obj.marginPct = marginPct;
  }

  for(const [ckey, obj] of combinedCounty){
    let bestParty = "";
    let bestVotes = -1;
    for(const [party, votes] of obj.partyVotes){
      if(votes > bestVotes){
        bestVotes = votes;
        bestParty = party;
      }
    }
    obj.winnerParty = bestParty;
  }

  const contestInfo = options.contestInfo || {
    title: `Folder (${contestKeys.length} contests)`,
    key: contestKeys.join(","),
    scopeCode: "SW",
    totalVotes
  };

  return {
    precinctAgg: combinedPrecinct,
    countyAgg: combinedCounty,
    contest: contestInfo,
    contests,
    isFolder: options.isFolder ?? true,
    usesCombinedKeys: true,
    contestKeys: expandedKeys
  };
}

function styleForFeatureFactory(active){
  return function(feature){
    const props = feature.properties || {};
    const county = norm(props.county_nam);
    const precinct = norm(joinValueFromFeature(props));
    const countyFilter = elCounty.value;
    const showLines = elLines.checked;
    const lineWeight = Math.max(0, Number(elLineWeight.value) || 0);
    const opacityScale = clamp01(Number(elLayerOpacity.value) || 0);
    const contestKey = elContest.value;

    if(countyFilter && county !== countyFilter){
      return {
        fillColor:"#111827",
        color: showLines ? "#334155" : "transparent",
        weight: showLines ? lineWeight * 0.4 : 0,
        fillOpacity:0.03 * opacityScale,
        opacity:0.08 * opacityScale
      };
    }

    if(!active){
      return {
        fillColor:"#111827",
        color: showLines ? "#334155" : "transparent",
        weight: showLines ? lineWeight * 0.7 : 0,
        fillOpacity:0.18 * opacityScale,
        opacity:0.35 * opacityScale
      };
    }

    const shade = elShade.value;
    const k = active.usesCombinedKeys ? `${county}|${precinct}` : `${contestKey}|${county}|${precinct}`;
    const m = resolvePrecinctAgg(active, k);

    if(!m || !m.winner){
      return {
        fillColor:"#111827",
        color: showLines ? "#334155" : "transparent",
        weight: showLines ? lineWeight * 0.6 : 0,
        fillOpacity:0.12 * opacityScale,
        opacity:0.25 * opacityScale
      };
    }

    if(shade === "party"){
      const base = winnerColor(m.winner);
      const turnoutFactor = clamp01((m.total || 0) / 1200);
      const tinted = tint(base, 0.55 - 0.35*turnoutFactor);
      return {
        fillColor:tinted,
        color: showLines ? "#0b1220" : "transparent",
        weight: showLines ? lineWeight : 0,
        fillOpacity:0.78 * opacityScale,
        opacity:0.6 * opacityScale
      };
    }

    if(shade === "margin"){
      const base = winnerColor(m.winner);
      const t = 0.75 - 0.65*clamp01(m.marginPct || 0);
      return {
        fillColor:tint(base, t),
        color: showLines ? "#0b1220" : "transparent",
        weight: showLines ? lineWeight : 0,
        fillOpacity:0.80 * opacityScale,
        opacity:0.6 * opacityScale
      };
    }

    const turnout = clamp01((m.total || 0) / 1500);
    const ccol = tint("#22c55e", 0.85 - 0.7*turnout);
    return {
      fillColor:ccol,
      color: showLines ? "#0b1220" : "transparent",
      weight: showLines ? lineWeight : 0,
      fillOpacity:0.78 * opacityScale,
      opacity:0.6 * opacityScale
    };
  }
}

function bindFeatureEvents(feature, layer){
  layer.on("mousemove", () => {
    const p = feature.properties || {};
    const countyRaw = (p.county_nam ?? "").toString();
    const precinctRaw = (joinValueFromFeature(p) ?? "").toString();
    hoverContext = {
      county: norm(countyRaw),
      precinct: norm(precinctRaw),
      countyLabel: countyRaw || norm(countyRaw),
      precinctLabel: precinctRaw || norm(precinctRaw)
    };
    elHover.textContent =
      `County: ${countyRaw}\n` +
      `prec_id: ${(p.prec_id ?? "").toString()}\n` +
      `enr_desc: ${(p.enr_desc ?? "").toString()}`;
    updateVoteTotals(lastActiveAgg);
  });
  layer.on("mouseout", () => {
    hoverContext = null;
    elHover.textContent = "—";
    updateVoteTotals(lastActiveAgg);
  });

  layer.on("click", async () => {
    const active = await getActiveAgg();
    const contestKey = elContest.value;
    if(!active){
      elClick.textContent = "Load a TSV or precompile contest packs first.";
      return;
    }

    const p = feature.properties || {};
    const county = norm(p.county_nam);
    const precinct = norm(joinValueFromFeature(p));
    const k = active.usesCombinedKeys ? `${county}|${precinct}` : `${contestKey}|${county}|${precinct}`;
    const m = resolvePrecinctAgg(active, k);

    if(!m || !m.winner){
      elClick.textContent = `No results matched.\nCounty: ${county}\nPrecinct: ${precinct}`;
      return;
    }

    const margin = ((m.marginPct || 0)*100).toFixed(1) + "%";
    const optionKey = optionKeyFromCandidate(m.winner.name);
    const partyLabel = optionKey ? `Option: ${optionKey}` : `Party: ${m.winner.party || "—"}`;

    elClick.textContent =
      `County: ${county}\n` +
      `Precinct: ${precinct}\n\n` +
      `Winner: ${m.winner.name || "—"}\n` +
      `${partyLabel}\n` +
      `Votes: ${Math.round(m.winner.votes || 0).toLocaleString()}\n` +
      `Total: ${Math.round(m.total || 0).toLocaleString()}\n` +
      `Margin: ${margin}`;
  });
}

async function updatePanels(active){
  const contestKey = elContest.value;
  const countyFilter = elCounty.value;

  if(!active){
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
    const kCounty = active.usesCombinedKeys ? k : k.split("|")[1];
    if(!active.usesCombinedKeys && !k.startsWith(contestKey + "|")) continue;
    if(countyFilter && kCounty !== countyFilter) continue;
    totalVotes += (v.total || 0);
  }

  if(precinctLayer){
    precinctLayer.eachLayer(layer => {
      const props = layer.feature.properties || {};
      const lyrCounty = norm(props.county_nam);
      if(countyFilter && lyrCounty !== countyFilter) return;
      const precinct = norm(joinValueFromFeature(props));
      const k = active.usesCombinedKeys ? `${lyrCounty}|${precinct}` : `${contestKey}|${lyrCounty}|${precinct}`;
      const m = resolvePrecinctAgg(active, k);
      if(m && m.winner) colored++; else missing++;
    });
  }

  elSummary.textContent =
    `Contest: ${c?.title ?? "(unknown)"}\n` +
    (active.isFolder ? `Folder size: ${active.contestKeys.length}\n` : "") +
    `Scope: ${scopeLabel}\n` +
    `Mode: ${elMode.value}\n` +
    `County filter: ${countyFilter || "none"}\n` +
    `Join field: ${elJoin.value}\n` +
    (lastNameSync ? `Name sync: ${lastNameSync.updated} updated, ${lastNameSync.missing} unmatched\n` : "") +
    `Mapped precincts: ${colored}\n` +
    `Missing precincts: ${missing}\n` +
    `Total votes (filtered): ${Math.round(totalVotes).toLocaleString()}`;

  // County scoreboard (top 12 by total votes)
  const rows = [];
  for(const [k, v] of active.countyAgg){
    const kCounty = active.usesCombinedKeys ? k : k.split("|")[1];
    if(!active.usesCombinedKeys && !k.startsWith(contestKey + "|")) continue;
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
  const active = await getActiveAgg();
  lastActiveAgg = active;
  if(!precinctLayer){
    updateVoteTotals(active);
    renderMismatchPanel();
    return;
  }
  precinctLayer.setStyle(styleForFeatureFactory(active));
  await updatePanels(active);
  updateVoteTotals(active);
  renderMismatchPanel();
}

async function getActiveAgg(){
  const contestKeys = getContestKeysForMap();
  if(!contestKeys.length) return null;
  if(elMapTarget.value === "folder"){
    return await getAggForContestKeys(contestKeys, { isFolder: true });
  }
  return await getAggForContestKey(contestKeys[0]);
}

async function init(){
  map = L.map("map", { preferCanvas:true }).setView([35.5, -79.4], 7);
  baseLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom:18,
    attribution:"&copy; OpenStreetMap"
  });
  if(elToggleBasemap.checked){
    baseLayer.addTo(map);
  }

  try{
    const res = await fetch(PRECINCTS_URL);
    if(!res.ok) throw new Error("precincts fetch failed");
    precinctFeatures = await res.json();
    const sample = getFirstCoordinate(precinctFeatures);
    const needsReproject = sample && (Math.abs(sample[0]) > 180 || Math.abs(sample[1]) > 90);
    if(needsReproject){
      if(typeof proj4 !== "function"){
        throw new Error("precincts.geojson uses projected coordinates; proj4 is required to reproject.");
      }
      const transform = (coord) => proj4(PRECINCT_CRS, "WGS84", coord);
      precinctFeatures = reprojectGeoJSON(precinctFeatures, transform);
    }
    fillCountyDropdown(precinctFeatures);

    precinctLayer = L.geoJSON(precinctFeatures, {
      style: styleForFeatureFactory(null),
      onEachFeature: bindFeatureEvents
    }).addTo(map);
  } catch (e){
    console.error(e);
    elSummary.textContent = "Precinct polygons failed to load. If you opened index.html directly, start a local server (e.g. python -m http.server) to avoid file:// CORS issues.";
  }

  // precompiled manifest (optional)
  manifest = await tryLoadManifest();

  fillContestDropdown();
  renderContestLibrary();
  renderFolderSelect();
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

function updateLineWeightLabel(){
  if(!elLineWeightValue) return;
  elLineWeightValue.textContent = Number(elLineWeight.value).toFixed(1);
}

function updateLayerOpacityLabel(){
  if(!elLayerOpacityValue) return;
  elLayerOpacityValue.textContent = Number(elLayerOpacity.value).toFixed(2);
}

function applyColorInputs(){
  colorInputs.forEach(input => {
    const scope = input.dataset.colorScope;
    const key = input.dataset.colorKey;
    const value = colorConfig?.[scope]?.[key];
    if(value){
      input.value = value;
    }
  });
}

updateLineWeightLabel();
updateLayerOpacityLabel();
applyColorInputs();

function applyPrecinctNameSync(rows){
  if(!precinctFeatures?.features?.length) return null;
  const nameById = new Map();
  for(const r of rows){
    const precinctName = (getCol(r, ["precinct_name","precinct","Precinct","precinct_desc"]) ?? "").trim();
    const precinctCode = norm(getCol(r, ["precinct_code","precinct_cd","precinct_id"]));
    if(precinctCode && precinctName){
      nameById.set(precinctCode, precinctName);
    }
  }
  if(!nameById.size) return { updated: 0, missing: 0 };
  let updated = 0;
  const missing = new Set(nameById.keys());
  for(const feature of precinctFeatures.features){
    const props = feature.properties || {};
    const precId = norm(props.prec_id);
    if(!precId || !nameById.has(precId)) continue;
    const newName = nameById.get(precId);
    missing.delete(precId);
    if(newName && norm(props.enr_desc) !== norm(newName)){
      props.enr_desc = newName;
      updated += 1;
    }
  }
  return { updated, missing: missing.size };
}

elMode.addEventListener("change", async () => {
  setModeUI();
  fillContestDropdown();
  renderFolderSelect();
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
    rememberRawTSV(text);
    const rows = parseTSV(text);
    tsvNameMismatches = computeTSVNameMismatches(rows);
    lastNameSync = elSyncNames?.checked ? applyPrecinctNameSync(rows) : null;
    buildAggregatesTSV(rows);
    fillContestDropdown();
    renderFolderSelect();
    await refresh();
  } catch (e){
    console.error(e);
    alert("Failed to load TSV. See console.");
  }
});

elDownload.addEventListener("click", async () => {
  if(elMode.value !== "tsv") return;
  elSummary.textContent = "Downloading statewide TSV…";
  try{
    const res = await fetch(STATEWIDE_TSV_URL, {cache:"no-store"});
    if(!res.ok) throw new Error("Failed download");
    const text = await res.text();
    rememberRawTSV(text);
    const rows = parseTSV(text);
    tsvNameMismatches = computeTSVNameMismatches(rows);
    lastNameSync = elSyncNames?.checked ? applyPrecinctNameSync(rows) : null;
    buildAggregatesTSV(rows);
    fillContestDropdown();
    renderFolderSelect();
    await refresh();
  } catch (e){
    console.error(e);
    alert("Failed to download TSV. Check your connection.");
  }
});

elSaveRawBtn.addEventListener("click", () => {
  if(!rawTSVText) return;
  downloadTextFile("results_raw/STATEWIDE_PRECINCT_SORT.txt", rawTSVText);
});

elReset.addEventListener("click", async () => {
  contestsTSV = [];
  precinctAggTSV.clear();
  countyAggTSV.clear();
  contestCache.clear();
  rawTSVText = "";
  rawTSVHeader = [];
  rawTSVContestIndex = -1;
  tsvNameMismatches = [];
  elSaveRawBtn.disabled = true;
  elContest.innerHTML = "";
  elScope.value = "ALL";
  elCounty.value = "";
  elShade.value = "party";
  elJoin.value = "join_prec_id";
  if(elSyncNames) elSyncNames.checked = false;
  lastNameSync = null;
  elLines.checked = true;
  elLineWeight.value = "0.6";
  elLayerOpacity.value = "0.8";
  updateLineWeightLabel();
  updateLayerOpacityLabel();
  selectedContestKeys.clear();
  renderContestLibrary();
  renderFolderSelect();
  await refresh();
});

elScope.addEventListener("change", async () => { fillContestDropdown(); await refresh(); });
elCounty.addEventListener("change", async () => { fillContestDropdown(); await refresh(); });
elContest.addEventListener("change", refresh);
elShade.addEventListener("change", refresh);
elJoin.addEventListener("change", refresh);
elLines.addEventListener("change", refresh);
elLineWeight.addEventListener("input", () => { updateLineWeightLabel(); refresh(); });
elLayerOpacity.addEventListener("input", () => { updateLayerOpacityLabel(); refresh(); });
colorInputs.forEach(input => {
  input.addEventListener("input", async () => {
    const scope = input.dataset.colorScope;
    const key = input.dataset.colorKey;
    if(!scope || !key) return;
    if(!colorConfig[scope]) colorConfig[scope] = {};
    colorConfig[scope][key] = input.value;
    saveColorConfig(colorConfig);
    await refresh();
  });
});
elToggleBasemap.addEventListener("change", () => {
  if(!baseLayer) return;
  if(elToggleBasemap.checked){
    baseLayer.addTo(map);
  } else {
    baseLayer.remove();
  }
});
if(elApplyMismatchBtn){
  elApplyMismatchBtn.addEventListener("click", applyMismatchUpdates);
}
elMapTarget.addEventListener("change", async () => {
  elFolderSelect.disabled = elMapTarget.value !== "folder" || !Object.keys(folders).length;
  await refresh();
});
elFolderSelect.addEventListener("change", refresh);
elFolderSelect.addEventListener("change", () => updateFolderSummary());

elContestSearch.addEventListener("input", () => {
  renderContestLibrary();
});

elContestList.addEventListener("change", (event) => {
  const target = event.target;
  if(target && target.matches("input[type='checkbox'][data-key]")){
    const key = target.getAttribute("data-key");
    if(target.checked){
      selectedContestKeys.add(key);
    } else {
      selectedContestKeys.delete(key);
    }
  }
});

elSelectAllBtn.addEventListener("click", () => {
  filteredContestKeys.forEach(key => selectedContestKeys.add(key));
  renderContestLibrary();
});

elClearSelectBtn.addEventListener("click", () => {
  filteredContestKeys.forEach(key => selectedContestKeys.delete(key));
  renderContestLibrary();
});

elAddFolderBtn.addEventListener("click", () => {
  const name = (elFolderName.value || "").trim();
  if(!name) return;
  if(!folders[name]) folders[name] = [];
  folderStore.save(folders);
  elFolderName.value = "";
  renderFolderSelect();
});

elAssignFolderBtn.addEventListener("click", () => {
  const name = elFolderSelect.value;
  if(!name) return;
  const keys = Array.from(selectedContestKeys);
  if(!keys.length) return;
  const existing = new Set(folders[name] || []);
  keys.forEach(k => existing.add(k));
  folders[name] = Array.from(existing);
  folderStore.save(folders);
  updateFolderSummary();
});

elExportFolderBtn.addEventListener("click", () => {
  const folderName = elFolderSelect.value;
  if(!folderName || !rawTSVText) return;
  if(rawTSVContestIndex < 0){
    alert("contest_title column not found in the TSV.");
    return;
  }
  const contestKeys = folders[folderName] || [];
  const contestTitles = new Set(
    contestKeys.map(key => getContestByKey(key)?.title).filter(Boolean)
  );
  if(!contestTitles.size){
    alert("Folder has no contests to export.");
    return;
  }
  const lines = rawTSVText.split(/\r?\n/);
  if(!lines.length) return;
  const output = [];
  const header = lines.find(l => l.trim().length);
  if(!header) return;
  output.push(header);
  for(let i=1;i<lines.length;i++){
    const line = lines[i];
    if(!line.trim()) continue;
    const cols = line.split("\t");
    const title = (cols[rawTSVContestIndex] ?? "").trim();
    if(contestTitles.has(title)){
      output.push(line);
    }
  }
  downloadTextFile(`results_raw/${folderName.replace(/\\s+/g, "_")}.txt`, output.join("\n"));
});

elRemoveFolderBtn.addEventListener("click", () => {
  const name = elFolderSelect.value;
  if(!name) return;
  delete folders[name];
  folderStore.save(folders);
  renderFolderSelect();
});

init().catch(err => {
  console.error(err);
  elSummary.textContent = "Error loading precinct polygons. See console.";
});
