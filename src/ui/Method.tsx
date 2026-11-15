// How the numbers are made, and the checks against outside references.
import { useEffect, useState } from "react";

const DATA: [string, string, string, string][] = [
  ["JPL DE440 planetary ephemeris and lunar orientation", "Where the Sun, Earth and Moon are, and how the Moon is turned", "NASA NAIF generic kernels (de440s.bsp, moon_pa_de440_200625.bpc, moon_de440_250416.tf)", "https://naif.jpl.nasa.gov/naif/data_generic.html"],
  ["LOLA polar elevation maps, 20 m and 240 m per pixel", "Terrain from 60°S to the pole", "LRO LOLA gridded data, PDS Geosciences Node (LDEM_80S_20M, LDEM_60S_240M)", "https://pds-geosciences.wustl.edu/missions/lro/lola.htm"],
  ["High-resolution LOLA site maps, 5 m per pixel", "Terrain close to the Artemis III candidate regions", "NASA Goddard Planetary Geodesy Data Archive, product 78 (Barker et al. 2021)", "https://pgda.gsfc.nasa.gov/products/78"],
  ["JPL Horizons System", "Independent check of every Sun and Earth angle", "Horizons API, observer tables for sites on the Moon", "https://ssd.jpl.nasa.gov/horizons/"],
  ["CGI Moon Kit colour and elevation maps", "The globe in the 3D view", "NASA Scientific Visualization Studio, from LROC and LOLA data", "https://svs.gsfc.nasa.gov/4720"],
  ["Blue Marble Next Generation", "The face of Earth in the 3D view", "NASA Earth Observatory", "https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/"],
];

export function Method() {
  const [hz, setHz] = useState<any>(null);
  const [bk, setBk] = useState<any>(null);
  useEffect(() => {
    fetch("/data/validation/horizons.json").then((r) => r.json()).then(setHz).catch(() => {});
    fetch("/data/validation/barker2021.json").then((r) => r.json()).then(setBk).catch(() => {});
  }, []);
  return (
    <div className="doc">
      <span className="kicker">Method and checks</span>
      <h1>How Longshadow gets its numbers, and how we know they are right.</h1>
      <p className="lead">Everything on this site is computed from open NASA data by code you can read and rerun. This page says what we compute, what we checked it against, and where the limits are.</p>

      <h2>What we compute</h2>
      <div className="defs">
        <div><h3>Sun and Earth direction</h3><p>We take the apparent positions of the Sun and Earth seen from the Moon from JPL's DE440 ephemeris with NASA's SPICE toolkit. Apparent means corrected for light travel time and aberration. They are expressed in the Moon's Mean Earth frame, which is the frame of the LOLA maps. The site's own position on the surface is then subtracted, which matters for Earth: it shifts by up to a quarter of a degree across the Moon. The app carries a table of these vectors every 6 hours from 2020 to 2050 and interpolates it. Outside those years it falls back to an analytic model.</p></div>
        <div><h3>Skyline</h3><p>For each site we trace 1,440 rays, one every 0.25 degrees, along great circles out to 500 km. Steps are 2.5 m near the site and grow with distance. Each sample reads terrain that is already averaged to the size of the step, so nothing is aliased and nothing is biased up or down. The elevation angle of every sample uses the exact geometry of a sphere with the terrain height added. The highest angle along a ray is the skyline in that direction. We store it for 2 m and 10 m above the ground.</p></div>
        <div><h3>Power</h3><p>The Sun is a disk about half a degree wide, and at the pole it grazes the skyline. So we do not ask whether the Sun is up or down. We cut the disk into 32 strips, clip each strip by the skyline, and weight by limb darkening. The result is the share of sunlight that reaches a Sun-facing panel, from 0 to 100 percent. The solar flux is scaled by the true Sun distance.</p></div>
        <div><h3>Direct link to Earth</h3><p>The link is counted as available when the centre of Earth is above the skyline by a margin you choose (0, 1, 2 or 5 degrees). We also report how much of Earth's disk is visible.</p></div>
        <div><h3>Windows and landing dates</h3><p>We sample a site through time, then refine every switch between on and off by bisection to about one second. For the comparison page we test every possible landing time in a year, two hours apart, against the mission's needs: stay length, longest time it survives without power, share of time with power, and link rules.</p></div>
        <div><h3>Sites</h3><p>For the 13 Artemis III candidate regions (and the Shackleton rim) we do not copy a coordinate from a table. We search NASA's 5 m map of each region for the best-lit spot with a slope under 10 degrees, within 6 km of the published centre. Past landing sites use their published coordinates.</p></div>
      </div>

      <h2>Checks</h2>
      <h3 className="th">1. Against JPL Horizons</h3>
      <p>Horizons is NASA's reference service for positions in the solar system. We asked it for the azimuth and elevation of the Sun and Earth from eight sites on the Moon, every two days for a year, and compared them with what the app computes for the same instants. Horizons uses the same lunar frame ({hz?.frame_lines?.find((l: string) => l.includes("pole"))?.split(":")[1]?.split("{")[0]?.trim() ?? "MEAN_ME"}).</p>
      {hz && (
        <table className="tbl">
          <thead><tr><th>Site</th><th>Epochs</th><th>Sun, largest gap</th><th>Sun, RMS</th><th>Earth, largest gap</th><th>Earth, RMS</th></tr></thead>
          <tbody>
            {hz.sites.map((s: any) => (
              <tr key={s.id}><td>{s.name}</td><td className="num">{s.sun.n}</td><td className="num">{s.sun.max_arcsec}″</td><td className="num">{s.sun.rms_arcsec}″</td><td className="num">{s.earth.max_arcsec}″</td><td className="num">{s.earth.rms_arcsec}″</td></tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={6}>Largest difference anywhere: {hz.worst_arcsec} arcseconds. One arcsecond is 1/3600 of a degree. The Sun is about 1,900 arcseconds wide. Checked {hz.checked_utc} UTC.</td></tr></tfoot>
        </table>
      )}

      <h3 className="th">2. Against published NASA illumination results</h3>
      <p>Barker et al. (2021) at NASA Goddard computed sunlight at seven small areas on the Connecting Ridge for 2024 and 2025. They give a low value (the average over each area) and a high value (the best pixel of the area at each hour). We evaluate one point, the centre of each area, so our value should fall between the two.</p>
      {bk && (
        <table className="tbl">
          <thead><tr><th>Area</th><th>Location</th><th>Ours, 1 m</th><th>Published range, 1 m</th><th>Ours, 5 m</th><th>Published range, 5 m</th><th>Longest dark spell, ours</th><th>Published range</th></tr></thead>
          <tbody>
            {bk.rows.map((r: any) => (
              <tr key={r.roi}>
                <td className="num">{r.roi}</td><td className="num">{Math.abs(r.lat).toFixed(3)}°S {r.lon.toFixed(2)}°E</td>
                <td className="num">{r.z1m.avg.toFixed(1)}%</td><td className="num">{r.z1m.barker_avg_A} to {r.z1m.barker_avg_C}%</td>
                <td className="num">{r.z5m.avg.toFixed(1)}%</td><td className="num">{r.z5m.barker_avg_A} to {r.z5m.barker_avg_C}%</td>
                <td className="num">{r.z1m.lcsp_d} d</td><td className="num">{r.z1m.barker_lcsp_C} to {r.z1m.barker_lcsp_A} d</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={8}>{bk.inside} of {bk.total} averages fall inside the published range. Reference: Barker, M. K. et al. (2021), Planetary and Space Science 203, Table 2.</td></tr></tfoot>
        </table>
      )}

      <h3 className="th">3. The browser against the pipeline</h3>
      <p>The same numbers are computed twice: once in Python with SPICE when the data are built, and once in your browser. An automated test recomputes a full year of sunlight and Earth visibility for every site with terrain in the browser code and requires agreement with the Python result within 0.15 percent. It also checks raw Horizons rows directly against the browser code.</p>

      <h2>Limits you should know</h2>
      <ul className="limits">
        <li>The terrain maps have errors. NASA estimates about 0.4 m of height error in the 5 m maps. Rocks and small craters below the map resolution are not there at all. Close to the ground a rock can block the Sun.</li>
        <li>Sites outside the polar maps (Apollo and other low-latitude landings) use a smooth sphere with no hills. The site list says which terrain each site uses.</li>
        <li>Custom points are computed in your browser from lighter maps (20 m near a listed site, 60 m near the pole, 240 m elsewhere), so they are less exact than the listed sites.</li>
        <li>Power here means sunlight reaching a Sun-facing panel. Panel pointing, temperature, dust and batteries are not modelled.</li>
        <li>The link test is about line of sight to Earth's centre. It does not check ground station schedules or radio reflections off the ground.</li>
        <li>The 3D view is a visualisation. Its shadows are ray marched on the graphics card from 240 m, 60 m and 20 m maps. All numbers in the app come from the skyline method above.</li>
      </ul>

      <h2>Data and tools</h2>
      <table className="tbl data">
        <thead><tr><th>Data</th><th>Used for</th><th>Source</th></tr></thead>
        <tbody>
          {DATA.map((d) => (
            <tr key={d[0]}><td>{d[0]}</td><td>{d[1]}</td><td><a href={d[3]} target="_blank" rel="noreferrer">{d[2]}</a></td></tr>
          ))}
        </tbody>
      </table>
      <p>Software: SpiceyPy and NumPy for the data pipeline, astronomy-engine for the analytic fallback and Earth rotation, three.js for the 3D view, React and Vite for the app.</p>

      <h2>Use of AI tools</h2>
      <p>We used an AI coding assistant (Anthropic Claude) to help write and review the code and the text of this project. No images, audio or data were generated by AI. Every number comes from the NASA data listed above, computed by the code in the repository, and the checks on this page can be rerun with the scripts in the pipeline folder.</p>
    </div>
  );
}
