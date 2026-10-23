server: - 2026-10-23 #318 the daily slot's roster request carries house roster names: the scheduler hook calls `seatRequests.openFor(t, store.roster.pick(N))` (spread over the models, rotating day to day); fewer active names than N leaves plain Delove seats
docs: - 2026-10-23 #318 tournaments.md: the daily tournament seats the house roster by name
