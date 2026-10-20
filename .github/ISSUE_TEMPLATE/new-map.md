---
name: New map
about: Track one new board from idea to GPU training (process in docs/map-making.md)
title: "New map: <name>"
labels: map
---

<!-- One issue per board. Tick each step as it happens and link the PRs. Process: docs/map-making.md. -->

**Map id:** `<id>`
**Reference or idea:** <!-- the reference picture (attach it here, never commit it) or a short description -->
**Made by:** <!-- the person or session making it -->

- [ ] Design approved by the owner (previews from `scripts/preview-map.mjs` attached; names original, chokepoints, bonuses)
- [ ] PR opened: #
- [ ] Reviewed and approved
- [ ] Merged by the owner (deployed)
- [ ] GPU-verified: `verify.py` run on the training PC and the fingerprint PR merged: #
- [ ] `npm run maps:status` shows it GPU-verified
- [ ] In the training rotation (`npm run maps:status`, column "rotation")
