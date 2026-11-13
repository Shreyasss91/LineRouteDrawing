# Documentation

Documentation for the **Line Route Drawing Generator** — an offline browser tool that
turns sequential electrical route instructions into line-route drawings, with vector
PDF, SVG and print export.

Every statement here was checked against the source code in this repository and against
executable tests, not against earlier plans or README text. Where something is
implemented but **not** validated, it says so. Where a claim could not be verified, it
says that too instead of guessing.

Test evidence on the working tree that produced these documents:

```
npm test               →  581 tests, 581 pass, 0 fail   (36 files)
npm run test:browser   →  355/355 browser checks passed (17 sections)
```

## Contents

| # | Document | Read this when you want to… |
| --- | --- | --- |
| 1 | [Overview and quick start](01-overview.md) | understand what the tool is and get it running |
| 2 | [User guide](02-user-guide.md) | use a control and know exactly what it does, or what it refuses |
| 3 | [Technical architecture](03-architecture.md) | change the code: layers, modules, contracts, dependency rules |
| 4 | [Route and geometry model](04-route-and-geometry.md) | understand coordinates, the graph, markers and clipping |
| 5 | [Persistence and project format](05-persistence.md) | read or write a project file, or reason about migrations and refusals |
| 6 | [Identity and network data](06-identity-and-data.md) | understand asset ids, designations, loads and span lengths |
| 7 | [Rendering and export](07-rendering-and-export.md) | understand rendering profiles, page layouts and fit-to-sheet |
| 8 | [Testing and development](08-testing.md) | run, add or trust the tests; follow the coding conventions |
| 9 | [Feature and validation matrix](09-feature-matrix.md) | check whether something is verified, partial, or unsupported |
| 10 | [Known limitations](10-limitations.md) | know what the tool cannot do, and what has not been validated |
| 11 | [Performance baseline](11-performance-baseline.md) | know what a drawing costs, and how to re-measure it |
| 12 | [Annotation placement](12-annotation-placement.md) | understand where a label's position comes from, and the spatial index behind it |
| — | [Findings](findings.md) | see defects and gaps recorded but deliberately **not** fixed |
| — | [Changelog](../CHANGELOG.md) | see what changed, when, and in which commit |

## Suggested reading paths

**A user who just wants to draw something**
→ [Overview](01-overview.md) §Install and start → [User guide](02-user-guide.md)
§1–§3 → [User guide](02-user-guide.md) §17.

**A reviewer checking whether this can be trusted**
→ [Feature and validation matrix](09-feature-matrix.md) →
[Known limitations §7](10-limitations.md#7-validation-status-by-area) →
[Findings](findings.md). The short version: the domain layer is heavily tested
(581 tests), the browser behaviour is checked end to end (355 checks), the drawing's cost
is measured rather than guessed ([baseline](11-performance-baseline.md)), and the gaps are
listed explicitly rather than glossed.

**A developer about to change the code**
→ [Architecture](03-architecture.md) §8 dependency rules →
[Testing](08-testing.md) §9 →
[Route and geometry](04-route-and-geometry.md) for anything touching coordinates →
[Persistence](05-persistence.md) for anything touching a saved field.

**Someone integrating the output**
→ [Rendering and export](07-rendering-and-export.md) §3 layouts, §4 PDF, §5 SVG,
§10 what each output contains.

## Conventions used throughout

- **Status words** are used precisely and always mean the same thing:
  *Verified* (automated test, passing), *Verified (manual)*, *Incomplete validation*,
  *Partial*, *Planned*, *Unsupported*. The definitions are at the top of
  [the feature matrix](09-feature-matrix.md#legend).
- **Cross-references** point at heading anchors, so they survive section renumbering.
- **Numbers** quoted for the example drawing (34 nodes, 33 edges, 536 × 736 px, 35 px
  spacing floor, four layouts) were produced by running the code, and each is named
  with the test that pins it.
- **Code location** is given as a relative link, so it is one click from the claim to
  the line that implements it.

## The one-paragraph summary

You enter an ordered list of route instructions — from which point, in which cardinal
direction, for how many spans, and whether the destination is an ordinary pole, a test
point (TC, a triangle) or a feeder pillar box (FPB, a labelled rectangle). The tool
replays those instructions into a canonical grid graph, names every pole from the named
point it grows out of (`Origin:1`, `A1`, `TC:2`), builds **one** normalized scene, and
renders that scene identically to the screen, to a vector PDF, to an editable SVG and to
one printed sheet of your chosen paper. Loads and span lengths are recorded against
stable asset ids rather than names, so editing the drawing never moves a number onto a
different pole. The project is remembered in the browser automatically and can be saved
to a versioned `.json` file; a file that is damaged, is not a project, or came from a
newer version is refused whole, and an unreadable remembered project is preserved rather
than overwritten. There is no server, no build step and no runtime network access.
