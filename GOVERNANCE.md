# Governance

## Model

Single maintainer. One person or agent acting for Obtranzat writes the code, reviews every pull
request, cuts releases and answers issues. There is no board, no steering committee and no company
behind this repository, and no plan to invent one for the sake of appearances.

## Decisions

| Decision                 | Who makes it                                                  | How you find out                                     |
| ------------------------ | ------------------------------------------------------------- | ---------------------------------------------------- |
| Merge a change           | maintainer                                                    | the pull request, with reasons in the review comment |
| Release a version        | maintainer                                                    | a git tag and a release note                         |
| Deprecate a finding code | maintainer, after at least one minor version of warning       | README table and the release note                    |
| Add a dependency         | maintainer, and only with a reason stated in the pull request | the pull request                                     |
| Change the licence       | not going to happen                                           | MIT forever, or a fork                               |

The two rules that bind the maintainer, because they are what users actually rely on:

1. **Finding codes are a public API.** A code keeps its meaning. A release may add codes, change
   severity, or reword a message; it may not make an existing code mean something different.
2. **Determinism is a feature, not an implementation detail.** No clock, no locale, no environment,
   no network. A change that would break that is a bug regardless of how useful it looks.

## Contributing

Open an issue first for anything that changes behaviour, so the shape can be argued before code
exists. A pull request needs: the change, a test that fails without it, and no new dependency unless
the issue already agreed one. `deno task check` has to pass. Run `deno fmt` before pushing.

Contributions are accepted under the MIT licence above. No CLA, no copyright assignment — the
maintainer has no legal entity to assign to.

## Independence

This project exists to serve invoice authors, not to sell a product. The maintainer also runs a paid
hosted invoice API that applies the same arithmetic, and that is disclosed in the README rather than
hidden. The library stays useful to someone who will never pay for anything: no licence keys, no
telemetry, no call home, no "pro" features withheld.

## Contact

Issues and pull requests on GitHub. That is the channel, and it is also the record — decisions are
not taken in private mail.
