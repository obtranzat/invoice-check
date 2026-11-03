import { checkInvoice, checkInvoiceJson, type Finding, parseMoney } from "./mod.ts";

const invoices = {
  minimal: {
    number: "INV-1",
    date: "2026-11-03",
    seller: { name: "Ada" },
    client: { name: "Grace" },
    items: [{ description: "Design", unitPrice: "100.00" }],
  },
  twoRates: {
    number: "INV-2026-014",
    date: "2026-11-03",
    dueDate: "2026-11-17",
    currency: "EUR",
    seller: { name: "Obtranzat", vatId: "FI00000000" },
    client: { name: "Client GmbH", vatId: "DE000000000" },
    items: [
      {
        description: "Consulting",
        quantity: 4,
        unitPrice: "60.00",
        taxRate: 25.5,
      },
      { description: "Book", quantity: 1, unitPrice: "20.00", taxRate: 10 },
    ],
  },
};

function assert(cond: boolean, note: string) {
  if (!cond) throw new Error(`FAILED: ${note}`);
}
function eq(actual: unknown, expected: unknown, note: string) {
  if (actual !== expected) {
    throw new Error(
      `FAILED: ${note} - expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}
const codes = (findings: Finding[]) => findings.map((f) => f.code);
const has = (findings: Finding[], code: string) => codes(findings).includes(code);

Deno.test("a correct invoice is valid and adds up", () => {
  const r = checkInvoice(invoices.minimal);
  assert(r.valid, "minimal invoice should pass");
  eq(r.errors, 0, "no errors");
  eq(r.totals?.netCents, 10000, "net in cents");
  eq(r.totals?.totalCents, 10000, "tax-free total in cents");
  eq(r.totals?.total, "100.00", "total in major units");
  eq(r.currency, "EUR", "currency defaults to EUR");
  eq(r.lines[0].quantity, 1, "quantity defaults to 1");
});

Deno.test("line totals, tax split by rate and rounding", () => {
  const r = checkInvoice(invoices.twoRates);
  assert(r.valid, "two-rate invoice should pass");
  eq(r.lines[0].netCents, 24000, "4 x 60.00");
  eq(r.lines[0].taxCents, 6120, "25.5% of 240.00");
  eq(r.lines[1].taxCents, 200, "10% of 20.00");
  eq(r.totals?.netCents, 26000, "net");
  eq(r.totals?.taxCents, 6320, "tax");
  eq(r.totals?.totalCents, 32320, "gross");
  eq(r.totals?.total, "323.20", "formatted total");
  eq(r.taxBreakdown.length, 2, "two rate groups");
  eq(r.taxBreakdown[0].rate, 10, "rates sorted ascending");
  eq(r.taxBreakdown[0].taxCents, 200, "10% group tax");
});

Deno.test("inclusive and exclusive tax describe the same charge", () => {
  const ex = checkInvoice({
    ...invoices.minimal,
    items: [{ description: "Design", unitPrice: "120.00", taxRate: 20 }],
  });
  const inc = checkInvoice({
    ...invoices.minimal,
    taxMode: "inclusive",
    items: [{ description: "Design", unitPrice: "120.00", taxRate: 20 }],
  });
  eq(ex.totals?.totalCents, 14400, "exclusive grosses up");
  eq(inc.totals?.totalCents, 12000, "inclusive keeps the charged amount");
  eq(inc.lines[0].netCents, 10000, "net derived by dividing");
  eq(inc.lines[0].taxCents, 2000, "tax is the remainder");
});

Deno.test("every visible problem is reported, not just the first", () => {
  const r = checkInvoice({
    number: "",
    date: "2026-02-30",
    dueDate: "2026-01-01",
    currency: "EURO",
    seller: { name: "Ada", email: "not-an-email" },
    client: {},
    items: [
      { description: "Same", unitPrice: "10.00" },
      { description: "same", unitPrice: "0.00" },
      { description: "", quantity: -2, unitPrice: "x", taxRate: 130 },
    ],
  });
  assert(!r.valid, "should be invalid");
  for (
    const code of [
      "NUMBER_MISSING",
      "DATE_INVALID",
      "DUE_BEFORE_ISSUE",
      "CURRENCY_INVALID",
      "EMAIL_FORMAT",
      "PARTY_NAME_MISSING",
      "DUPLICATE_LINE",
      "ITEM_DESCRIPTION_MISSING",
      "ITEM_QUANTITY_INVALID",
      "ITEM_PRICE_INVALID",
      "ITEM_TAX_RATE_INVALID",
      "ITEM_ZERO_PRICE",
    ]
  ) {
    assert(has(r.findings, code), `expected finding ${code}`);
  }
  eq(r.totals, null, "no totals when a line is unusable");
});

Deno.test("a leap year February 29th is real and a non-leap one is not", () => {
  const base = {
    ...invoices.minimal,
    seller: { name: "Ada" },
    client: { name: "Grace" },
  };
  assert(
    checkInvoice({ ...base, date: "2028-02-29" }).valid,
    "2028 is a leap year",
  );
  assert(
    !checkInvoice({ ...base, date: "2026-02-29" }).valid,
    "2026 is not a leap year",
  );
});

Deno.test("aliases, string numbers and unknown keys are accepted", () => {
  const r = checkInvoice({
    number: "INV-9",
    date: "2026-11-03",
    from: { name: "Ada" },
    to: { name: "Grace" },
    poNumber: "PO-55",
    items: [{
      description: "Work",
      quantity: "2",
      unitPrice: 12.5,
      taxRate: "20",
    }],
  });
  assert(r.valid, "aliases should satisfy the party check");
  eq(r.lines[0].netCents, 2500, "string quantity applied");
  eq(r.lines[0].taxCents, 500, "string tax rate applied");
});

Deno.test("money parsing", () => {
  eq(parseMoney("1,234.56"), 123456, "thousands separator");
  eq(parseMoney("0.5"), 50, "one decimal");
  eq(parseMoney(2), 200, "integer number");
  eq(
    parseMoney("1.234,56"),
    null,
    "European separators rejected rather than guessed",
  );
  eq(parseMoney("-5"), null, "negative rejected");
  eq(parseMoney("12.345"), null, "sub-cent string rejected");
  eq(parseMoney(undefined), null, "missing price");
  eq(parseMoney("1e3"), null, "exponent notation");
  eq(
    parseMoney(0.005),
    1,
    "a sub-cent number rounds to a cent and is warned about by the caller",
  );
});

Deno.test("an array, a scalar and malformed JSON all fail cleanly", () => {
  eq(checkInvoice([]).findings[0].code, "BODY_NOT_OBJECT", "array input");
  eq(checkInvoice("nope").findings[0].code, "BODY_NOT_OBJECT", "string input");
  eq(checkInvoice(null).findings[0].code, "BODY_NOT_OBJECT", "null input");
  const bad = checkInvoiceJson("{oops");
  eq(bad.findings[0].code, "JSON_PARSE_FAILED", "broken JSON");
  assert(!bad.valid && bad.errors === 1, "one error, invalid");
  assert(
    checkInvoiceJson(JSON.stringify(invoices.minimal)).valid,
    "round trip through JSON text",
  );
});

Deno.test("an over-long description and more than 100 lines are refused", () => {
  const long = checkInvoice({
    ...invoices.minimal,
    items: [{ description: "x".repeat(301), unitPrice: "10.00" }],
  });
  assert(has(long.findings, "ITEM_DESCRIPTION_LONG"), "description length cap");
  const many = checkInvoice({
    ...invoices.minimal,
    items: Array.from(
      { length: 101 },
      (_, i) => ({ description: `line ${i}`, unitPrice: "1.00" }),
    ),
  });
  assert(has(many.findings, "ITEMS_RANGE"), "line count cap");
});
