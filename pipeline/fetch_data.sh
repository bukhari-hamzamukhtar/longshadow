#!/usr/bin/env bash
# Download the raw NASA data used by the pipeline (about 3 GB).
# Usage: bash pipeline/fetch_data.sh data_raw
set -euo pipefail
OUT="${1:-data_raw}"
mkdir -p "$OUT/kernels" "$OUT/lola" "$OUT/site5m" "$OUT/tex"

NAIF="https://naif.jpl.nasa.gov/pub/naif/generic_kernels"
for f in lsk/naif0012.tls pck/pck00011.tpc spk/planets/de440s.bsp pck/moon_pa_de440_200625.bpc fk/satellites/moon_de440_250416.tf; do
  curl -sS --retry 3 -o "$OUT/kernels/$(basename "$f")" "$NAIF/$f"
done

PDS="https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img"
for f in ldem_80s_20m.lbl ldem_80s_20m.img ldem_60s_240m.lbl ldem_60s_240m.img; do
  curl -sS --retry 5 -C - -o "$OUT/lola/$f" "$PDS/$f"
done

PGDA="https://pgda.gsfc.nasa.gov/data/LOLA_5mpp"
for s in Site01 Site04 Site07 Site11 SL2 SL3 LM7 Haworth Site23 Site20v2 Site06 DM2 DM1 Site42; do
  curl -sS --retry 5 -C - -o "$OUT/site5m/$s.tif" "$PGDA/$s/${s}_final_adj_5mpp_surf.tif"
done

SVS="https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720"
curl -sS --retry 3 -o "$OUT/tex/lroc_color_poles_4k.tif" "$SVS/lroc_color_poles_4k.tif"
curl -sS --retry 3 -o "$OUT/tex/ldem_16_uint.tif" "$SVS/ldem_16_uint.tif"
curl -sS --retry 3 -o "$OUT/tex/earth_5400.jpg" \
  "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography-bathymetry/december/world.topo.bathy.200412.3x5400x2700.jpg"
echo "done: $OUT"
