# NC Election Viewer Pro+

## What you get
- Precinct map (from your NC precinct shapefile)
- Toggle precinct boundary lines on/off
- Two modes:
  1) **Precompiled (fast)**: instant contest switching via small JSON packs
  2) **Load TSV**: load a big TSV/TXT in the browser (slower, but no preprocessing)

---

## Run the viewer
From this folder:

```bash
python -m http.server 8000
```

Open:
http://localhost:8000

---

## Recommended: Precompile the statewide file (FAST MODE)

1) Create this folder:

```
results_raw/
```

2) Put your downloaded file here:

```
results_raw/STATEWIDE_PRECINCT_SORT.txt
```

3) Run:

```bash
python tools/precompile_statewide.py
```

This creates:

- `data/precompiled/manifest.json`
- `data/precompiled/contests/*.json`

4) Start the server and use **Mode = Precompiled**.

---

## Alternate: TSV mode (no preprocessing)

- Set Mode = **Load TSV**
- Click **Load**
- Choose the same STATEWIDE_PRECINCT_SORT.txt

---

## Join field tip
If you see lots of “missing precincts”, flip Join field:
- `enr_desc (name)` usually matches `precinct_name` like PATTERSON
- `prec_id (code)` if your file uses codes
