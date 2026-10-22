server: - 2026-10-22 #241 nested (and scheduled) tournaments default every table to autoSetup, capitals and 4 blizzards (`NESTED_DEFAULT_OPTIONS`, owner's request), still overridable at creation
engine: - 2026-10-22 #241 `startOnSpots`: a spot thawed because its blizzard had nowhere to move no longer ends up cut off; the blizzards next to it thaw too until the open territories are one network (found by a new max-blizzards test over every generated nested board shape)
docs: - 2026-10-22 #241 tournaments.md: tournament-mode defaults and the thaw rule
