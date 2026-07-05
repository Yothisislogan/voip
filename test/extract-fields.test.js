import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVin, extractDob, extractAddress, extractVehicles, extractDrivers, extractBusiness } from "../src/ai/extract.js";

test("extractVin finds a valid 17-char VIN with a letter and digit", () => {
  assert.equal(extractVin("my vin is 1HGCM82633A004352 ok"), "1HGCM82633A004352");
  assert.equal(extractVin("no vin here"), null);
  assert.equal(extractVin("1234567890 too short"), null);
});

test("extractDob parses birth dates to ISO", () => {
  assert.equal(extractDob("I was born on 03/15/1985"), "1985-03-15");
  assert.equal(extractDob("DOB: 1/2/90"), "1990-01-02");
  assert.equal(extractDob("date of birth 12-31-2000"), "2000-12-31");
  assert.equal(extractDob("no date"), null);
});

test("extractAddress captures a street address", () => {
  assert.match(extractAddress("I live at 123 Main Street, Phoenix AZ 85001 now"), /123 Main Street/);
  assert.equal(extractAddress("no address"), null);
});

test("extractVehicles parses year/make/model, deduped", () => {
  const v = extractVehicles("I have a 2019 Toyota Camry and a 2021 Ford F150");
  assert.deepEqual(v, [
    { year: 2019, make: "Toyota", model: "Camry" },
    { year: 2021, make: "Ford", model: "F150" },
  ]);
});

test("extractDrivers strips filler words like 'Add'", () => {
  assert.deepEqual(extractDrivers("Add my wife Jane Smith as a driver"), ["Jane Smith"]);
});

test("extractBusiness pulls company name + type without leading filler", () => {
  const b = extractBusiness("I also run Acme Trucking LLC, a trucking business");
  assert.equal(b.business_name, "Acme Trucking LLC");
  assert.equal(b.business_type, "Trucking");
});
