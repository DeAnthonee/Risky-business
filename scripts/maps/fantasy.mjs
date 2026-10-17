// Realms of Halvaren: an original fantasy board, hand-authored (no real geography).
// Coordinates are the map's own viewBox (size). Each landmass is a coarse outline whose coast the
// generator roughens; territory `site`s partition a landmass into noisy-bordered Voronoi cells, and a
// landmass with `territory` is a single-territory island. Land adjacency comes from shared borders;
// `seaLanes` add the crossings over water (drawn as link lines). See scripts/authored-map.mjs.
export default {
  id: 'fantasy',
  kind: 'authored',
  name: 'Realms of Halvaren (87)',
  maxPlayers: 10,
  size: [1000, 700],
  seed: 'halvaren-1',
  // Starting armies per player live in packages/engine/src/maps.ts (STARTING_ARMIES.fantasy).
  continents: [
    { id: 'orlenne', name: 'Orlenne', bonus: 5, label: [95, 110] },
    { id: 'vessaline', name: 'Vessaline', bonus: 3, label: [56, 538] },
    { id: 'brannoch', name: 'Brannoch Vale', bonus: 4, label: [220, 319] },
    { id: 'corvel', name: 'Corvel Hills', bonus: 3, label: [468, 470] },
    { id: 'thornwild', name: 'Thornwild', bonus: 3, label: [150, 550] },
    { id: 'grimward', name: 'Grimward Wastes', bonus: 7, label: [640, 15] },
    { id: 'hrimvald', name: 'Hrimvald', bonus: 3, label: [936, 13] },
    { id: 'odrun', name: 'Odrun Peaks', bonus: 4, label: [590, 239] },
    { id: 'kethran', name: 'Kethran Dominion', bonus: 5, label: [832, 304] },
    { id: 'gloamfen', name: 'Gloamfen', bonus: 4, label: [930, 589] },
    { id: 'solmara', name: 'Solmara', bonus: 5, label: [800, 598] },
    { id: 'sunscar', name: 'Sunscar Desert', bonus: 5, label: [565, 598] },
    { id: 'mistveil', name: 'Mistveil Isle', bonus: 2, label: [482, 252] },
    { id: 'shardsea', name: 'Shardsea Isles', bonus: 3, label: [330, 24] },
    { id: 'tanuvai', name: 'Tanuvai Isles', bonus: 3, label: [335, 690] },
    { id: 'saltreach', name: 'Saltreach Keys', bonus: 2, label: [780, 691] },
  ],
  landmasses: [
    {
      // One horseshoe continent around the Inner Sea: the western kingdoms, the Grimward Wastes across
      // the north, and the eastern lands, joined by two necks of land.
      id: 'mainland',
      outline: [
        // Orlenne north coast (Stag Bay, the Keep's headland)
        [40, 190], [50, 165], [62, 148], [88, 132], [112, 140], [126, 158], [142, 140], [160, 124], [188, 128], [205, 104], [232, 96],
        [258, 110], [282, 124], [305, 118], [330, 132], [348, 118],
        // western neck, then the Grimward north shore with two fjords
        [360, 96], [346, 74], [366, 54], [398, 46], [430, 30], [462, 40], [490, 22], [520, 34], [550, 30], [580, 40], [592, 74], [604, 40],
        [630, 26], [660, 36], [690, 30], [700, 66], [712, 34], [740, 40], [770, 32], [800, 40], [828, 30], [852, 52], [870, 86],
        [846, 110], [862, 146], [842, 178], [812, 200], [790, 214],
        // eastern neck, Kethran north shore and the Dawnreach cape
        [804, 240], [830, 252], [856, 234], [886, 244], [916, 226], [948, 240], [968, 268], [990, 290], [996, 314], [982, 334], [962, 338],
        // east coast, Gloamfen, Solmara's southern cape
        [972, 366], [958, 392], [976, 420], [984, 452], [966, 478], [984, 502], [962, 532], [936, 546], [900, 566], [872, 560],
        [850, 572], [830, 560], [808, 574], [782, 576], [762, 588], [738, 590], [720, 580], [700, 572],
        // Sunscar south and its Inner Sea shore
        [672, 566], [648, 580], [618, 574], [590, 562], [566, 548], [548, 526], [530, 500], [546, 470], [526, 440], [540, 410],
        [522, 382], [536, 350], [528, 322], [550, 296], [580, 272], [610, 268], [640, 250], [668, 240], [688, 216],
        // Grimward south shore with the Bone Bay
        [664, 204], [638, 214], [612, 206], [588, 214], [566, 200], [548, 180], [530, 172], [514, 186], [500, 200], [470, 208],
        [440, 196], [412, 188], [398, 174],
        // Corvel shore of the Inner Sea
        [388, 198], [400, 224], [414, 252], [426, 284], [410, 312], [404, 340], [424, 364], [430, 394], [412, 424], [402, 454],
        [380, 476], [358, 500], [342, 524],
        // Thornwild south coast and its cape
        [312, 532], [286, 522], [266, 536], [250, 554], [228, 552], [214, 538], [192, 530], [166, 526], [140, 514], [118, 522], [96, 506],
        // Vessaline west coast and Cape Merrow
        [82, 480], [62, 470], [44, 452], [30, 430], [20, 400], [34, 384], [50, 366], [38, 348], [22, 330], [28, 300], [44, 282],
        [28, 262], [36, 236], [24, 212],
      ],
      lakes: [
        // Brannoch Mere, in the heart of the vale
        [[205, 305], [222, 298], [236, 308], [232, 324], [214, 328], [202, 318]],
        // the Drownwater, in the Gloamfen
        [[902, 452], [918, 444], [934, 452], [932, 468], [914, 474], [900, 466]],
      ],
    },
    {
      id: 'hrimvald',
      outline: [[892, 28], [920, 20], [948, 30], [972, 22], [990, 50], [978, 84], [992, 112], [980, 140], [994, 170], [972, 200], [948, 214], [918, 208], [896, 186], [904, 160], [884, 136], [898, 108], [878, 84], [888, 56]],
    },
    {
      id: 'mistveil',
      outline: [[462, 270], [488, 262], [508, 280], [516, 310], [502, 336], [512, 362], [518, 392], [500, 422], [476, 430], [456, 414], [450, 386], [462, 362], [452, 334], [444, 304]],
    },
    // Shardsea Isles: a chain of single-territory islets off the northwest coast.
    { id: 'shard1', territory: 'gannet_rock', outline: [[24, 52], [40, 42], [58, 48], [64, 64], [52, 78], [32, 76], [22, 64]] },
    { id: 'shard2', territory: 'shard_isle', outline: [[84, 28], [100, 18], [120, 22], [128, 36], [116, 48], [96, 46]] },
    { id: 'shard3', territory: 'kelpholm', outline: [[144, 56], [162, 48], [178, 54], [182, 70], [166, 80], [148, 74]] },
    { id: 'shard4', territory: 'lantern_skerry', outline: [[208, 28], [226, 18], [244, 26], [246, 42], [230, 50], [212, 44]] },
    { id: 'shard5', territory: 'wreckers_isle', outline: [[276, 58], [294, 50], [312, 58], [314, 74], [298, 84], [280, 78]] },
    // Tanuvai Isles: three jungle islands in the south-west.
    { id: 'tanuvai_w', outline: [[72, 590], [96, 572], [128, 578], [150, 566], [184, 572], [206, 594], [198, 618], [208, 640], [180, 656], [148, 648], [118, 660], [86, 646], [70, 620]] },
    { id: 'tanuvai_m', outline: [[234, 600], [258, 584], [290, 590], [318, 578], [350, 590], [364, 612], [352, 634], [338, 662], [300, 668], [270, 656], [244, 660], [230, 630]] },
    { id: 'tanuvai_e', outline: [[390, 584], [414, 566], [444, 572], [470, 560], [494, 580], [490, 604], [498, 626], [470, 644], [438, 640], [410, 648], [392, 624]] },
    // Saltreach Keys: two pirate islands in the south-east.
    { id: 'saltreach_w', outline: [[604, 622], [630, 608], [664, 614], [700, 612], [736, 620], [760, 636], [744, 658], [712, 668], [676, 660], [640, 670], [612, 656]] },
    { id: 'saltreach_e', outline: [[802, 628], [828, 612], [862, 618], [896, 606], [930, 614], [962, 634], [950, 658], [918, 670], [880, 662], [846, 672], [812, 658]] },
  ],
  territories: [
    // Kingdom of Orlenne
    { id: 'northwatch', name: 'Northwatch', continent: 'orlenne', land: 'mainland', site: [85, 185] },
    { id: 'stagmere', name: 'Stagmere', continent: 'orlenne', land: 'mainland', site: [150, 170] },
    { id: 'orlenne_keep', name: 'Orlenne Keep', continent: 'orlenne', land: 'mainland', site: [215, 160] },
    { id: 'brightcrest', name: 'Brightcrest', continent: 'orlenne', land: 'mainland', site: [280, 165] },
    { id: 'harrowgate', name: 'Harrowgate', continent: 'orlenne', land: 'mainland', site: [345, 175] },
    { id: 'elmsworth', name: 'Elmsworth', continent: 'orlenne', land: 'mainland', site: [220, 225] },
    // Vessaline Coast
    { id: 'port_vessa', name: 'Port Vessa', continent: 'vessaline', land: 'mainland', site: [65, 250] },
    { id: 'gullcliff', name: 'Gullcliff', continent: 'vessaline', land: 'mainland', site: [120, 285] },
    { id: 'brinewick', name: 'Brinewick', continent: 'vessaline', land: 'mainland', site: [60, 320] },
    { id: 'lanterne_bay', name: 'Lanterne Bay', continent: 'vessaline', land: 'mainland', site: [115, 355] },
    { id: 'ostrey', name: 'Ostrey', continent: 'vessaline', land: 'mainland', site: [70, 400] },
    { id: 'cape_merrow', name: 'Cape Merrow', continent: 'vessaline', land: 'mainland', site: [115, 445] },
    // Brannoch Vale
    { id: 'brannoch', name: 'Brannoch', continent: 'brannoch', land: 'mainland', site: [180, 275] },
    { id: 'millbrook', name: 'Millbrook', continent: 'brannoch', land: 'mainland', site: [245, 285] },
    { id: 'thistlemead', name: 'Thistlemead', continent: 'brannoch', land: 'mainland', site: [185, 345] },
    { id: 'oakenford', name: 'Oakenford', continent: 'brannoch', land: 'mainland', site: [255, 350] },
    { id: 'wrenfield', name: 'Wrenfield', continent: 'brannoch', land: 'mainland', site: [300, 240] },
    // Corvel Hills
    { id: 'corvel_tor', name: 'Corvel Tor', continent: 'corvel', land: 'mainland', site: [365, 245] },
    { id: 'shepherds_rise', name: "Shepherd's Rise", continent: 'corvel', land: 'mainland', site: [370, 315] },
    { id: 'cairnmoor', name: 'Cairnmoor', continent: 'corvel', land: 'mainland', site: [320, 380] },
    { id: 'greystep', name: 'Greystep', continent: 'corvel', land: 'mainland', site: [375, 430] },
    // The Thornwild
    { id: 'briarheart', name: 'Briarheart', continent: 'thornwild', land: 'mainland', site: [180, 410] },
    { id: 'fernhallow', name: 'Fernhallow', continent: 'thornwild', land: 'mainland', site: [255, 425] },
    { id: 'old_thicket', name: 'Old Thicket', continent: 'thornwild', land: 'mainland', site: [170, 480] },
    { id: 'sylvane_glade', name: 'Sylvane Glade', continent: 'thornwild', land: 'mainland', site: [240, 485] },
    { id: 'hartwood', name: 'Hartwood', continent: 'thornwild', land: 'mainland', site: [310, 475] },
    // Grimward Wastes
    { id: 'bleakpass', name: 'Bleakpass', continent: 'grimward', land: 'mainland', site: [385, 95] },
    { id: 'howling_steppe', name: 'Howling Steppe', continent: 'grimward', land: 'mainland', site: [450, 70] },
    { id: 'bonefield', name: 'Bonefield', continent: 'grimward', land: 'mainland', site: [470, 160] },
    { id: 'scorched_barrens', name: 'Scorched Barrens', continent: 'grimward', land: 'mainland', site: [540, 100] },
    { id: 'raiders_roost', name: "Raiders' Roost", continent: 'grimward', land: 'mainland', site: [590, 175] },
    { id: 'gallows_hill', name: 'Gallows Hill', continent: 'grimward', land: 'mainland', site: [630, 75] },
    { id: 'blackscree', name: 'Blackscree', continent: 'grimward', land: 'mainland', site: [680, 150] },
    { id: 'wyrmgrave', name: 'Wyrmgrave', continent: 'grimward', land: 'mainland', site: [750, 75] },
    { id: 'kaelspire_ruins', name: 'Kaelspire Ruins', continent: 'grimward', land: 'mainland', site: [800, 135] },
    // Hrimvald
    { id: 'hrim_fjord', name: 'Hrim Fjord', continent: 'hrimvald', land: 'hrimvald', site: [925, 55] },
    { id: 'rimeholt', name: 'Rimeholt', continent: 'hrimvald', land: 'hrimvald', site: [955, 105] },
    { id: 'icewake', name: 'Icewake', continent: 'hrimvald', land: 'hrimvald', site: [915, 140] },
    { id: 'skaldhorn', name: 'Skaldhorn', continent: 'hrimvald', land: 'hrimvald', site: [950, 185] },
    // Odrun Peaks
    { id: 'odrun_gate', name: 'Odrun Gate', continent: 'odrun', land: 'mainland', site: [725, 255] },
    { id: 'anvil_crag', name: 'Anvil Crag', continent: 'odrun', land: 'mainland', site: [655, 290] },
    { id: 'highspire', name: 'Highspire', continent: 'odrun', land: 'mainland', site: [590, 320] },
    { id: 'deepdelve', name: 'Deepdelve', continent: 'odrun', land: 'mainland', site: [710, 335] },
    { id: 'stormcrown', name: 'Stormcrown', continent: 'odrun', land: 'mainland', site: [640, 370] },
    // Kethran Dominion
    { id: 'aurum_gate', name: 'Aurum Gate', continent: 'kethran', land: 'mainland', site: [800, 270] },
    { id: 'kethra', name: 'Kethra', continent: 'kethran', land: 'mainland', site: [870, 262] },
    { id: 'dawnreach', name: 'Dawnreach', continent: 'kethran', land: 'mainland', site: [938, 290] },
    { id: 'velantis', name: 'Velantis', continent: 'kethran', land: 'mainland', site: [790, 335] },
    { id: 'sarrach', name: 'Sarrach', continent: 'kethran', land: 'mainland', site: [860, 330] },
    { id: 'ivorstrand', name: 'Ivorstrand', continent: 'kethran', land: 'mainland', site: [930, 355] },
    { id: 'corrovan', name: 'Corrovan', continent: 'kethran', land: 'mainland', site: [825, 395] },
    // The Gloamfen
    { id: 'witchmire', name: 'Witchmire', continent: 'gloamfen', land: 'mainland', site: [895, 410] },
    { id: 'drownwater', name: 'Drownwater', continent: 'gloamfen', land: 'mainland', site: [950, 440] },
    { id: 'hagsbog', name: 'Hagsbog', continent: 'gloamfen', land: 'mainland', site: [876, 484] },
    { id: 'blightroot', name: 'Blightroot', continent: 'gloamfen', land: 'mainland', site: [940, 510] },
    { id: 'sunken_abbey', name: 'Sunken Abbey', continent: 'gloamfen', land: 'mainland', site: [870, 535] },
    // Solmara
    { id: 'solmara', name: 'Solmara', continent: 'solmara', land: 'mainland', site: [755, 405] },
    { id: 'amberlea', name: 'Amberlea', continent: 'solmara', land: 'mainland', site: [715, 465] },
    { id: 'highcourt', name: 'Highcourt', continent: 'solmara', land: 'mainland', site: [790, 460] },
    { id: 'seraphine', name: 'Seraphine', continent: 'solmara', land: 'mainland', site: [745, 525] },
    { id: 'torvane', name: 'Torvane', continent: 'solmara', land: 'mainland', site: [815, 520] },
    { id: 'lilyport', name: 'Lilyport', continent: 'solmara', land: 'mainland', site: [690, 540] },
    // Sunscar Desert
    { id: 'qasr_idir', name: 'Qasr Idir', continent: 'sunscar', land: 'mainland', site: [575, 385] },
    { id: 'glass_flats', name: 'Glass Flats', continent: 'sunscar', land: 'mainland', site: [645, 430] },
    { id: 'mirage_oasis', name: 'Mirage Oasis', continent: 'sunscar', land: 'mainland', site: [580, 450] },
    { id: 'sandspire', name: 'Sandspire', continent: 'sunscar', land: 'mainland', site: [690, 400] },
    { id: 'scarab_wells', name: 'Scarab Wells', continent: 'sunscar', land: 'mainland', site: [640, 495] },
    { id: 'dust_gate', name: 'Dust Gate', continent: 'sunscar', land: 'mainland', site: [585, 525] },
    { id: 'red_mesa', name: 'Red Mesa', continent: 'sunscar', land: 'mainland', site: [630, 550] },
    // Mistveil Isle
    { id: 'veilspire', name: 'Veilspire', continent: 'mistveil', land: 'mistveil', site: [480, 300] },
    { id: 'mistveil_harbor', name: 'Mistveil Harbor', continent: 'mistveil', land: 'mistveil', site: [475, 350] },
    { id: 'pale_strand', name: 'Pale Strand', continent: 'mistveil', land: 'mistveil', site: [485, 400] },
    // Shardsea Isles
    { id: 'gannet_rock', name: 'Gannet Rock', continent: 'shardsea' },
    { id: 'shard_isle', name: 'Shard Isle', continent: 'shardsea' },
    { id: 'kelpholm', name: 'Kelpholm', continent: 'shardsea' },
    { id: 'lantern_skerry', name: 'Lantern Skerry', continent: 'shardsea' },
    { id: 'wreckers_isle', name: "Wreckers' Isle", continent: 'shardsea' },
    // Tanuvai Isles
    { id: 'tanuvai', name: 'Tanuvai', continent: 'tanuvai', land: 'tanuvai_w', site: [110, 605] },
    { id: 'jade_falls', name: 'Jade Falls', continent: 'tanuvai', land: 'tanuvai_w', site: [170, 615] },
    { id: 'mangrove_reach', name: 'Mangrove Reach', continent: 'tanuvai', land: 'tanuvai_m', site: [265, 620] },
    { id: 'emberpeak', name: 'Emberpeak', continent: 'tanuvai', land: 'tanuvai_m', site: [328, 625] },
    { id: 'vinewall', name: 'Vinewall', continent: 'tanuvai', land: 'tanuvai_e', site: [418, 600] },
    { id: 'turtle_cay', name: 'Turtle Cay', continent: 'tanuvai', land: 'tanuvai_e', site: [462, 612] },
    // Saltreach Keys
    { id: 'saltreach', name: 'Saltreach', continent: 'saltreach', land: 'saltreach_w', site: [645, 632] },
    { id: 'rumhaven', name: 'Rumhaven', continent: 'saltreach', land: 'saltreach_w', site: [715, 632] },
    { id: 'smugglers_key', name: "Smuggler's Key", continent: 'saltreach', land: 'saltreach_e', site: [845, 635] },
    { id: 'cutlass_key', name: 'Cutlass Key', continent: 'saltreach', land: 'saltreach_e', site: [918, 632] },
  ],
  /** Crossings over water. Land borders are found from the shapes. */
  seaLanes: [
    // Shardsea chain
    ['gannet_rock', 'shard_isle'], ['shard_isle', 'kelpholm'], ['kelpholm', 'lantern_skerry'], ['lantern_skerry', 'wreckers_isle'],
    ['gannet_rock', 'northwatch'], ['kelpholm', 'orlenne_keep'], ['wreckers_isle', 'bleakpass'],
    // Hrimvald
    ['hrim_fjord', 'wyrmgrave'], ['icewake', 'kaelspire_ruins'], ['skaldhorn', 'dawnreach'],
    // Mistveil, the stepping stone across the Inner Sea
    ['veilspire', 'bonefield'], ['mistveil_harbor', 'shepherds_rise'], ['pale_strand', 'qasr_idir'],
    // Short crossings out of the Grimward Wastes
    ['bonefield', 'corvel_tor'], ['raiders_roost', 'highspire'],
    // Tanuvai
    ['tanuvai', 'old_thicket'], ['jade_falls', 'mangrove_reach'], ['emberpeak', 'vinewall'], ['turtle_cay', 'dust_gate'], ['turtle_cay', 'saltreach'],
    // Saltreach
    ['rumhaven', 'smugglers_key'], ['rumhaven', 'seraphine'], ['cutlass_key', 'blightroot'],
  ],
};
