# invoice-check

Validate an invoice document and work out its totals — offline, in one function call, with no
dependencies.

Written for the case where an invoice arrives as JSON from something that has never seen your tax
rules: a form, an integration, an agent. It reports **every** problem it can see instead of stopping
at the first one, and it does the arithmetic in integer cents so the answer is exact.

```ts
import { checkInvoice } from "./mod.ts";

const result = checkInvoice({
  number: "INV-2026-014",
  date: "2026-11-03",
  dueDate: "2026-11-17",
  currency: "EUR",
  seller: { name: "Obtranzat", vatId: "FI00000000" },
  client: { name: "Client GmbH", vatId: "DE000000000" },
  items: [
    { description: "Consulting", quantity: 4, unitPrice: "60.00", taxRate: 25.5 },
    { description: "Book", quantity: 1, unitPrice: "20.00", taxRate: 10 },
  ],
});

result.valid; // true
result.totals; // { netCents: 26000, taxCents: 6320, totalCents: 32320, total: "323.20" }
result.taxBreakdown; // [{ rate: 10, ... }, { rate: 25.5, ... }]
result.findings; // []
```

## Guarantees

- **Deterministic.** No clock, no locale, no `Intl`, no environment variables. Same input, same
  output, forever.
- **Exact money.** Amounts are integers (cents) internally; `0.1 + 0.2` never reaches a total.
- **Zero dependencies.** One TypeScript file, standard library only. Works in Deno, in a browser
  after a compile, and anywhere else that runs ES modules.
- **Nothing is silently guessed.** `"1.234,56"` is rejected rather than read as either 1234.56 or
  1.23456.

## Non-goals

This is a shape and arithmetic checker, not tax advice and not a format conformance tool:

- it does not know which VAT rate is legal in which country, or in which year;
- it does not validate Finvoice, Peppol BIS, XRechnung or any other interchange format — it
  validates the JSON document described below;
- it does not check a VAT number against VIES, only against the common EU/UK character shape;
- it does not reject negative amounts, because a credit note is a different document, not an invoice
  with a minus sign.

## API

### `checkInvoice(data: unknown): InvoiceCheck`

Validates and totals an invoice object. Unknown keys are ignored, so a superset of this shape is
fine.

### `checkInvoiceJson(text: string): InvoiceCheck`

The same on a JSON string, with a parse failure reported as `JSON_PARSE_FAILED` instead of an
exception.

### `parseMoney(raw: unknown): number | null`

An amount in cents, or `null`. Accepts numbers and plain decimal strings; a comma is a thousands
separator; at most two decimals for strings; negative and non-finite values are `null`.

### The result

| Field                                                                      | Meaning                                                                                                   |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `valid`                                                                    | no finding of severity `error`                                                                            |
| `errors` / `warnings` / `infos`                                            | counts by severity                                                                                        |
| `findings`                                                                 | every problem, as `{ severity, code, path, message }`                                                     |
| `totals`                                                                   | net, tax and gross in cents, plus the gross in major units — `null` if the lines are too broken to add up |
| `lines`                                                                    | each line as charged: unit price, rate, net, tax, gross                                                   |
| `taxBreakdown`                                                             | tax grouped by rate, ascending                                                                            |
| `invoiceNumber`, `currency`, `issueDate`, `dueDate`, `taxMode`, `taxLabel` | normalised inputs, including defaults                                                                     |

## Input shape

```json
{
  "number": "INV-2026-014",
  "date": "2026-11-03",
  "dueDate": "2026-11-17",
  "currency": "EUR",
  "taxMode": "exclusive",
  "taxLabel": "VAT",
  "seller": { "name": "…", "address": "…", "email": "…", "vatId": "…" },
  "client": { "name": "…", "vatId": "…" },
  "items": [{ "description": "…", "quantity": 4, "unitPrice": "60.00", "taxRate": 25.5 }],
  "notes": "…"
}
```

`from` is accepted for `seller`, and `to` or `customer` for `client`. Defaults: `quantity` 1,
`taxRate` 0, `currency` EUR, `taxMode` exclusive, `taxLabel` VAT. Dates are `YYYY-MM-DD` and must be
real calendar dates. `taxMode: "inclusive"` means `unitPrice` already contains tax, so the net is
derived by dividing by `100 + rate` and the tax is the remainder — the gross charged is the same
either way.

## Finding codes

The code is the stable contract; the message is allowed to be reworded.

| Code                       | Severity | Meaning                                                              |
| -------------------------- | -------- | -------------------------------------------------------------------- |
| `BODY_NOT_OBJECT`          | error    | the document is not an object                                        |
| `JSON_PARSE_FAILED`        | error    | the text is not valid JSON                                           |
| `PARTY_MISSING`            | error    | `seller` or `client` absent                                          |
| `PARTY_NAME_MISSING`       | error    | a party has no name                                                  |
| `PARTY_SAME`               | warning  | seller and client have the same name                                 |
| `EMAIL_FORMAT`             | warning  | an email address does not look like one                              |
| `VAT_ID_FORMAT`            | info     | a tax ID does not match a common EU/UK shape                         |
| `CURRENCY_INVALID`         | error    | currency is not a 3-letter ISO 4217 code                             |
| `NUMBER_MISSING`           | error    | no invoice number                                                    |
| `NUMBER_LONG`              | warning  | invoice number longer than 40 characters                             |
| `DATE_INVALID`             | error    | issue date is not a real `YYYY-MM-DD` date                           |
| `DUE_DATE_INVALID`         | error    | due date is not a real `YYYY-MM-DD` date                             |
| `DUE_BEFORE_ISSUE`         | warning  | due date earlier than issue date                                     |
| `ITEMS_RANGE`              | error    | fewer than 1 or more than 100 lines                                  |
| `ITEM_NOT_OBJECT`          | error    | a line is not an object                                              |
| `ITEM_DESCRIPTION_MISSING` | error    | a line has no description                                            |
| `ITEM_DESCRIPTION_LONG`    | error    | description longer than 300 characters                               |
| `DUPLICATE_LINE`           | warning  | two lines with the same description                                  |
| `ITEM_QUANTITY_INVALID`    | error    | quantity not between 0 and 100000                                    |
| `ITEM_PRICE_INVALID`       | error    | unit price not a valid non-negative amount                           |
| `ITEM_PRICE_SUBCENT`       | warning  | a numeric price had more than 2 decimals and was rounded             |
| `ITEM_ZERO_PRICE`          | info     | the line is free                                                     |
| `ITEM_ROUNDING`            | info     | quantity × price does not land on a whole cent; the line was rounded |
| `ITEM_TAX_RATE_INVALID`    | error    | rate not between 0 and 100                                           |
| `TAX_MODE_UNKNOWN`         | warning  | `taxMode` was neither exclusive nor inclusive                        |
| `NOTES_LONG`               | info     | notes exceed 2000 characters and would be truncated                  |
| `TOTAL_LARGE`              | warning  | total above 1,000,000 in major units                                 |

## Using it

Deno:

```ts
import { checkInvoice } from "https://raw.githubusercontent.com/obtranzat/invoice-check/main/mod.ts";
```

Node or a browser: `tsc mod.ts --module nodenext --target es2022` (or any bundler) — there is
nothing to install.

## Tests

```
deno test
```

Nine tests, all pure function calls, no fixtures, no network.

## Why this exists

It is the validator behind a paid machine-payable invoice API, extracted so that the checking step
can run without a network, an account or a payment. The hosted endpoint applies the same arithmetic;
this library is where the rules are documented and tested.

## Licence

MIT — see [LICENSE](LICENSE).
