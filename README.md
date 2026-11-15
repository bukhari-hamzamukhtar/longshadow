# Longshadow

**A lunar landing site navigator.** Pick a site on the Moon and a date. Longshadow shows where the Sun and Earth sit above the real terrain horizon, when the lander has solar power, and when it can talk to Earth directly. Then it compares sites and landing dates side by side.

Built for the NASA Space Apps Challenge 2026, challenge "Lunar Landing Site Navigator".

Live app: LIVE_URL

## What you can do with it

- **See the sky from the lander.** A panorama with the real skyline from NASA laser altimeter data, and the Sun and Earth drawn at their true size and position.
- **Watch the shadows move.** A 3D view of the Moon and the south pole. Shadows are cast live from the terrain toward the true Sun direction. A second mode lights up every place that can see Earth right now.
- **Read the windows.** A timeline shows when power and the Earth link are on and off, down to the minute. Countdown to the next sunset and the next loss of signal.
- **Compare sites and dates.** Set what the mission needs (stay length, how long it survives without power, link rules). Every site gets a one year calendar of landing dates that work. If the launch slips by a month you can see at once which site still works.
- **Use any point.** 29 sites are ready: the 13 Artemis III candidate regions, the Shackleton rim, the south pole, IM-1, IM-2, LCROSS, Chandrayaan-3, all six Apollo sites and more. You can also type coordinates or drop a pin, and the horizon is computed in your browser.

## How we know the numbers are right

| Check | Result |
|---|---|
| Sun and Earth angles against the **JPL Horizons System**, 8 sites, one year, 2,928 comparisons | Largest difference **0.098 arcseconds** (0.00003 degrees). Sun alone: 0.011 arcseconds. |
| Sunlight on the Connecting Ridge against **Barker et al. 2021** (NASA Goddard), 7 areas, 2 heights | **14 of 14** averages fall inside the published range |
| Browser code against the Python and SPICE pipeline, one year, every site with terrain | Agreement within 0.15 percent, enforced by an automated test |
| LCROSS impact site in Cabeus crater | 0 percent sunlight all year, as expected for a permanently shadowed crater |

The checks can be rerun: see "Rebuild the data" below. The app shows the full tables on its "Method and checks" page.

## How it works

1. **Sun and Earth.** Apparent positions seen from the Moon come from JPL's DE440 ephemeris through NASA's SPICE toolkit, in the Moon Mean Earth frame, which is the frame of the terrain maps. Light time and aberration are included. The app ships a table of these vectors every 6 hours from 2020 to 2050 and interpolates it with a 4 point cubic (error under 0.02 arcseconds). Outside that range it falls back to an analytic model.
2. **Terrain.** LOLA elevation maps from the Lunar Reconnaissance Orbiter: 5 m per pixel around the candidate regions, 20 m down to 80°S, 240 m down to 60°S.
3. **Skyline.** From each site, 1,440 rays go out along great circles to 500 km. Steps are 2.5 m near the site and grow with distance. Each sample reads terrain already averaged to the step size. Elevation angles use exact sphere geometry. The highest angle along a ray is the skyline in that direction.
4. **Windows.** The Sun is a disk half a degree wide that grazes the skyline at the pole. So the disk is cut into strips and clipped by the skyline, with limb darkening. That gives the share of sunlight from 0 to 100 percent. The Earth link is available when Earth's centre clears the skyline by a margin you choose. Switch times are refined by bisection to about one second.

For the Artemis III regions the site coordinates are found by the pipeline itself: it searches NASA's 5 m map of each region for the best lit spot with a slope under 10 degrees, within 6 km of the published centre.

## Data

| Data | Used for | Source |
|---|---|---|
| JPL DE440 ephemeris and lunar orientation kernels | Sun, Earth and Moon positions and Moon rotation | [NASA NAIF generic kernels](https://naif.jpl.nasa.gov/naif/data_generic.html) |
| LOLA polar elevation maps `LDEM_80S_20M`, `LDEM_60S_240M` | Terrain to 60°S | [PDS Geosciences Node, LRO LOLA](https://pds-geosciences.wustl.edu/missions/lro/lola.htm) |
| High resolution LOLA site maps, 5 m per pixel | Terrain near the Artemis III candidate regions | [NASA PGDA product 78](https://pgda.gsfc.nasa.gov/products/78), Barker et al. 2021 |
| JPL Horizons System API | Independent check of Sun and Earth angles | [ssd.jpl.nasa.gov/horizons](https://ssd.jpl.nasa.gov/horizons/) |
| CGI Moon Kit colour and elevation maps | Globe in the 3D view | [NASA SVS 4720](https://svs.gsfc.nasa.gov/4720) |
| Blue Marble Next Generation | Earth in the 3D view | [NASA Earth Observatory](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/) |

Reference for the illumination check: Barker, M. K., et al. (2021). Improved LOLA elevation maps for south pole landing sites: Error estimates and their impact on illumination conditions. *Planetary and Space Science*, 203, 105119.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # engine checks against Horizons and the pipeline
npm run build    # production build in dist/
```

The built data the app needs is already in `public/data`, so you do not need Python to run it.

## Rebuild the data

You need Python 3.10 or newer and about 3 GB of disk for the raw NASA files.

```bash
pip install -r pipeline/requirements.txt
bash pipeline/fetch_data.sh data_raw                                   # download kernels, LOLA maps, textures
python pipeline/build_ephemeris.py data_raw/kernels public/data 2020 2050 6
python pipeline/build_sites.py data_raw public/data                    # site search and skylines, about 15 minutes
python pipeline/build_terrain.py data_raw public/data                  # terrain and textures for the 3D view
python pipeline/validate_literature.py data_raw public/data/validation/barker2021.json
python pipeline/validate_horizons.py public/data public/data/validation/horizons.json
```

## Layout

```
pipeline/        Python: ephemeris table, site search, skylines, terrain assets, the two validation scripts
public/data/     Everything the app loads: ephemeris, sites, skylines, terrain, textures, validation results
src/lib/         The engine: ephemeris, sky geometry, windows, live skyline for custom points
src/three/       3D Moon view and shaders
src/ui/          Pages: story, navigator, comparison, method
tests/           Engine tests
```

## Limits

- Terrain maps have errors (about 0.4 m in the 5 m maps) and do not contain rocks or small craters. Close to the ground a rock can block the Sun.
- Sites outside the polar maps, such as the Apollo sites, use a smooth sphere without hills. The app labels the terrain used for every site.
- Custom points use lighter maps in the browser and are less exact than the listed sites.
- Power means sunlight on a Sun facing panel. Panel pointing, temperature, dust and batteries are not modelled.
- The link test is line of sight to Earth's centre. Ground station schedules are not included.
- The 3D view is a visualisation. All numbers come from the skyline method.

## Use of AI tools

We used an AI coding assistant (Anthropic Claude) to help write and review the code and text of this project. No images, audio or data were generated by AI. Every number comes from the NASA data listed above, computed by the code in this repository.

## Licence and credits

Code: MIT, see `LICENSE`. NASA data are in the public domain. Please credit NASA, the LRO LOLA team, NASA Goddard PGDA, JPL NAIF and JPL Solar System Dynamics when you reuse them. This is a student project and is not endorsed by NASA.
