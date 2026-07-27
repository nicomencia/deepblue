import { describe, expect, it } from "vitest";
import { photoMatchesEra } from "./wikipedia-photo";

/**
 * Every URL here is one the system actually served or fetched on 2026-07-27 —
 * the gate is judged against the real failures, not invented ones.
 */
const SWIFT_2024 =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/3/30/Suzuki_Swift_%282024%29_hybrid_DSC_7922.jpg/960px-Suzuki_Swift_%282024%29_hybrid_DSC_7922.jpg";
const MAZDA2_2021 =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/2021_Mazda2_GT_Sport_NAV_MHEV_1.5_Front.jpg/960px-2021_Mazda2.jpg";
const JAZZ_GE =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b6/2008-2010_Honda_Jazz_%28GE%29_hatchback_%282011-10-25%29.jpg/960px-x.jpg";
const YARIS_II_FACELIFT =
  "https://commons.wikimedia.org/wiki/Special:FilePath/Toyota_Yaris_II_Facelift_20090912_front.JPG?width=640";
const ELISE_2018 =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/Lotus_Elise_Sport_220%2C_Paris_Motor_Show_2018%2C_IMG_0651.jpg/960px-x.jpg";
const GOLF_VII_2017 =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5c/2017_Volkswagen_Golf_%285G_MY17%29_1.4_SE_TSI_hatchback.jpg/960px-x.jpg";
const PEUGEOT_207 =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0e/Peugeot_207_02.jpg/960px-Peugeot_207_02.jpg";
// Wikidata's XP90 pick: a 2011 car photographed in 2019 — the filename holds
// both years, and the in-band one must be enough.
const YARIS_XP90_WIKIDATA =
  "https://commons.wikimedia.org/wiki/Special:FilePath/2011%20Toyota%20Yaris%201.5%20S%20Limited%20hatchback%20%28NCP91R%3B%2001-09-2019%29%2C%20South%20Tangerang.jpg?width=640";

describe("photoMatchesEra", () => {
  it("rejects the current-generation photos that shipped on 2026-07-27", () => {
    expect(photoMatchesEra(SWIFT_2024, { yearMin: 2005, yearMax: 2017 })).toBe(false);
    expect(photoMatchesEra(MAZDA2_2021, { yearMin: 2007, yearMax: 2014 })).toBe(false);
    expect(photoMatchesEra(ELISE_2018, { yearMin: 1996, yearMax: 2011 })).toBe(false);
  });

  it("accepts era-correct photos, including facelifts and late photo dates", () => {
    expect(photoMatchesEra(JAZZ_GE, { yearMin: 2008, yearMax: 2015 })).toBe(true);
    expect(photoMatchesEra(YARIS_II_FACELIFT, { yearMin: 2005, yearMax: 2011 })).toBe(true);
    expect(photoMatchesEra(GOLF_VII_2017, { yearMin: 2012, yearMax: 2019 })).toBe(true);
    // one in-band year is enough even when the photo date is much later
    expect(photoMatchesEra(YARIS_XP90_WIKIDATA, { yearMin: 2005, yearMax: 2011 })).toBe(true);
  });

  it("passes filenames with no year — absence of data is not a mismatch", () => {
    expect(photoMatchesEra(PEUGEOT_207, { yearMin: 2007, yearMax: 2012 })).toBe(true);
  });

  it("passes everything when the hunt has no band", () => {
    expect(photoMatchesEra(SWIFT_2024)).toBe(true);
    expect(photoMatchesEra(SWIFT_2024, {})).toBe(true);
  });

  it("gives slack after the band ends but none worth mentioning before it starts", () => {
    // yearMax 2011 + 2 slack: a 2013-titled photo may be the same body
    expect(photoMatchesEra("https://x.test/2013_Car_Model.jpg", { yearMin: 2005, yearMax: 2011 })).toBe(true);
    expect(photoMatchesEra("https://x.test/2014_Car_Model.jpg", { yearMin: 2005, yearMax: 2011 })).toBe(false);
    // a photo titled years before the generation existed cannot be it
    expect(photoMatchesEra("https://x.test/2002_Car_Model.jpg", { yearMin: 2005, yearMax: 2011 })).toBe(false);
  });
});
