# Security policy

`invoice-check` is a pure function over data you already hold. It opens no sockets, reads no files,
runs no subprocess, touches no clock or locale, and has no dependencies — so the usual supply-chain
surface is empty by construction, and an upgrade cannot silently add one.

## What it does and does not defend

- Input is treated as untrusted data. Every value is type-checked before use, and no string reaches
  HTML, SQL, a shell or a filesystem here, because the library builds no output document — it
  returns findings and numbers.
- The work is bounded: at most 100 lines are totalled, descriptions are measured against a
  300-character cap, and quantities are capped at 100000. Amounts are integers in cents, so totals
  do not drift with scale.
- It is not a parser for invoice interchange formats and does not decompress, decode or embed
  anything. If you feed it XML, a PDF or a base64 blob, the decoding layer is yours and its risks
  stay there.
- Findings can echo back parts of the input (an email address, a VAT ID, a description). If you
  render `finding.message` into a page, escape it like any other user-supplied string.

## Reporting a vulnerability

Use **private vulnerability reporting** on this repository (Security → "Report a vulnerability"),
which reaches the maintainer without publishing the details. If that form is unavailable, open a
[GitHub issue](https://github.com/obtranzat/invoice-check/issues) only when the problem is already
public and does not describe a working exploit.

The maintainer aims to acknowledge within 7 days and to publish a fixed release within 30 days of a
confirmed report. There is no bounty and no paid disclosure programme: this is a one-maintainer
project, and the reporter gets their name in the release notes if they want it.

## Version support

Only the latest release is supported. Security fixes land in `main` and are released as a patch
version; there is no separate back-port branch until a second major line exists.
