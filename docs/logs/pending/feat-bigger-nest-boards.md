engine: - 2026-10-27 #327 generated boards default to 8 territories per seat (was 5; 4 to 10 allowed, was 4 to 6), owner's request; ids keep their size, so saved boards never change
server: - 2026-10-27 #327 nested tournaments' territoriesPerSeat defaults to the engine's 8 and accepts 4 to 10
mcp: - 2026-10-27 #327 create_tournament and preview_tournament take territoriesPerSeat 4 to 10 (default 8)
