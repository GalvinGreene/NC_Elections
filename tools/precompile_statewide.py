#!/usr/bin/env python3
"""
Precompile NCSBE STATEWIDE_PRECINCT_SORT.txt into tiny per-contest JSON packs.

Input:
  results_raw/STATEWIDE_PRECINCT_SORT.txt   (tab-delimited, with a header row)

Output:
  data/precompiled/manifest.json
  data/precompiled/contests/<contest_file>.json

Each contest pack is lightweight and contains:
  precinctAgg: { "contestKey|COUNTY|PRECINCT": {total, winner:{name,party,votes}, marginPct, candVotes} }
  countyAgg:   { "contestKey|COUNTY": {total, winnerParty, candVotes} }

Run from project root:
  python tools/precompile_statewide.py
"""

import csv, json, re
from pathlib import Path

IN_DIR = Path("results_raw")
OUT_DIR = Path("data/precompiled")
CONTEST_DIR = OUT_DIR / "contests"

OUT_DIR.mkdir(parents=True, exist_ok=True)
CONTEST_DIR.mkdir(parents=True, exist_ok=True)

def norm(s: str) -> str:
    return (s or "").strip().upper()

def safe_filename(s: str) -> str:
    s = s.strip()
    s = re.sub(r"[^\w\-]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s[:140] if s else "contest"

def get(row, *names):
    for n in names:
        if n in row and row[n] != "":
            return row[n]
    return ""

def scope_code(row):
    raw = get(row, "contest_scope", "contest_sc", "contest_p", "scope")
    raw = str(raw).strip()
    low = raw.lower()
    if "state" in low:
        return "SW"
    if "county" in low:
        return "CO"
    if raw == "3":
        return "CO"
    if raw == "1":
        return "SW"
    return "OT"

def main():
    # pick the biggest .txt/.tsv in results_raw if exact file isn't present
    candidates = []
    fallback_candidates = []
    for p in IN_DIR.glob("*"):
        if p.is_file():
            fallback_candidates.append(p)
        if p.suffix.lower() in [".txt", ".tsv"]:
            candidates.append(p)
    if not candidates:
        candidates = fallback_candidates
    if not candidates:
        raise SystemExit("No files found in results_raw/. Put STATEWIDE_PRECINCT_SORT.txt there.")

    inp = None
    for p in candidates:
        if p.name.upper() in ["STATEWIDE_PRECINCT_SORT.TXT"]:
            inp = p
            break
    if inp is None:
        inp = max(candidates, key=lambda p: p.stat().st_size)

    print("Reading:", inp)

    precinctAgg = {}   # contestKey|COUNTY|PRECINCT -> temp {total, candVotes{cand:{votes,party}}}
    precinctLookup = {}  # alias contestKey|COUNTY|ALIAS -> canonical contestKey|COUNTY|PRECINCT
    countyAgg = {}     # contestKey|COUNTY -> temp {total, partyVotes{party:votes}, candVotes{cand:{votes,party}}}
    contestMeta = {}   # contestKey -> {id,title,scopeCode,counties:set,totalVotes,file}

    with inp.open("r", encoding="utf-8", errors="replace", newline="") as f:
        reader = csv.DictReader(f, delimiter="\t")
        if reader.fieldnames is None:
            raise SystemExit("File appears to have no header row. Expected tab-delimited with headers.")
        for row in reader:
            county = norm(get(row, "county", "County"))
            precinct_name = norm(get(row, "precinct_name", "precinct", "Precinct", "precinct_desc"))
            precinct_code = norm(get(row, "precinct_code", "precinct_cd", "precinct_id"))
            precinct = precinct_name or precinct_code
            contest_id = norm(get(row, "contest_id", "contest", "contestid"))
            title = get(row, "contest_title", "contest_name", "contest", "Contest").strip()
            cand = get(row, "candidate", "choice", "Candidate").strip()
            party = get(row, "candidate_party", "choice_party", "party", "Party").strip()
            votes_raw = get(row, "vote_ct", "votes", "total votes", "Total Votes")

            if not county or not precinct or not contest_id or not title or not cand:
                continue

            try:
                votes = int(str(votes_raw).replace(",", "") or "0")
            except ValueError:
                votes = 0

            s = scope_code(row)
            contest_key = f"{contest_id}||{title}"

            if contest_key not in contestMeta:
                contest_file = safe_filename(f"{contest_id}_{title}") + ".json"
                contestMeta[contest_key] = {
                    "key": contest_key,
                    "id": contest_id,
                    "title": title,
                    "scopeCode": s,
                    "counties": set(),
                    "totalVotes": 0,
                    "file": contest_file,
                }
            meta = contestMeta[contest_key]
            meta["counties"].add(county)
            meta["totalVotes"] += votes

            pk = f"{contest_key}|{county}|{precinct}"
            pobj = precinctAgg.get(pk)
            if pobj is None:
                pobj = {"total": 0, "candVotes": {}}
                precinctAgg[pk] = pobj
            pobj["total"] += votes
            cv = pobj["candVotes"].get(cand)
            if cv is None:
                cv = {"votes": 0, "party": party}
                pobj["candVotes"][cand] = cv
            cv["votes"] += votes
            if not cv.get("party") and party:
                cv["party"] = party

            for alias in {precinct_name, precinct_code}:
                if not alias:
                    continue
                alias_key = f"{contest_key}|{county}|{alias}"
                precinctLookup[alias_key] = pk

            ck = f"{contest_key}|{county}"
            cobj = countyAgg.get(ck)
            if cobj is None:
                cobj = {"total": 0, "partyVotes": {}, "candVotes": {}}
                countyAgg[ck] = cobj
            cobj["total"] += votes
            if party:
                cobj["partyVotes"][party] = cobj["partyVotes"].get(party, 0) + votes
            ccv = cobj["candVotes"].get(cand)
            if ccv is None:
                ccv = {"votes": 0, "party": party}
                cobj["candVotes"][cand] = ccv
            ccv["votes"] += votes
            if not ccv.get("party") and party:
                ccv["party"] = party

    # Split per contest into separate small files
    print("Finalizing and writing contest packs…")
    # Build lookup of keys by contest for efficient write
    keys_by_contest = {}
    for pk in precinctAgg.keys():
        ck = pk.split("|", 1)[0]  # contestKey
        keys_by_contest.setdefault(ck, []).append(pk)

    county_keys_by_contest = {}
    for ck in countyAgg.keys():
        ckey = ck.split("|", 1)[0]
        county_keys_by_contest.setdefault(ckey, []).append(ck)

    written = 0
    for contest_key, meta in contestMeta.items():
        p_out = {}
        for pk in keys_by_contest.get(contest_key, []):
            obj = precinctAgg[pk]
            candVotes = obj["candVotes"]
            # winner + runner up
            winner = None
            second_votes = 0
            for cand, v in candVotes.items():
                vv = v.get("votes", 0)
                if winner is None or vv > winner["votes"]:
                    if winner is not None:
                        second_votes = max(second_votes, winner["votes"])
                    winner = {"name": cand, "party": v.get("party",""), "votes": vv}
                else:
                    second_votes = max(second_votes, vv)
            total = obj["total"]
            marginPct = ((winner["votes"] - second_votes) / total) if total else 0.0
            p_out[pk] = {"total": total, "winner": winner, "marginPct": marginPct, "candVotes": candVotes}

        c_out = {}
        for ck in county_keys_by_contest.get(contest_key, []):
            obj = countyAgg[ck]
            partyVotes = obj["partyVotes"]
            best_party = ""
            best_votes = -1
            for party, vv in partyVotes.items():
                if vv > best_votes:
                    best_votes = vv
                    best_party = party
            c_out[ck] = {
                "total": obj["total"],
                "winnerParty": best_party,
                "candVotes": obj["candVotes"],
            }

        lookup_out = {}
        for alias_key, canonical_key in precinctLookup.items():
            if not alias_key.startswith(contest_key + "|"):
                continue
            lookup_out[alias_key] = canonical_key

        pack = {
            "meta": {
                "key": contest_key,
                "title": meta["title"],
                "scopeCode": meta["scopeCode"],
                "totalVotes": meta["totalVotes"],
            },
            "precinctAgg": p_out,
            "precinctLookup": lookup_out,
            "countyAgg": c_out,
        }

        out_path = CONTEST_DIR / meta["file"]
        out_path.write_text(json.dumps(pack), encoding="utf-8")
        written += 1

    manifest = {
        "generatedFrom": inp.name,
        "contestCount": written,
        "contests": [
            {
                "key": m["key"],
                "id": m["id"],
                "title": m["title"],
                "scopeCode": m["scopeCode"],
                "counties": sorted(list(m["counties"])),
                "totalVotes": m["totalVotes"],
                "file": m["file"],
            }
            for m in contestMeta.values()
        ],
    }
    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    print("Wrote", written, "contest packs + manifest.json")

if __name__ == "__main__":
    main()
