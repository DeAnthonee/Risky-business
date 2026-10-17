// Earth: 438 territories in 77 regions and 26 tournament arenas, made for tournaments of up to 100
// players (docs/tournament.md).
// Natural Earth 1:50m countries on a canvas three times as wide as the other world maps. Small
// countries are one territory (crowded neighbours are merged), big ones are split into provinces:
// `split` parts give every territory the Voronoi cell around its `site` (or `sites`) inside the
// country, so a province is a named point rather than a hand-cut box. Land adjacency is derived
// from the shapes; `seaLanes` add the crossings over water. Region bonuses are left to the
// generator's suggestion (size plus entry points). See scripts/build-map.mjs.

/** Territories that split country `c` (optionally clipped to a box first). */
/** Rows of [id, name, site | sites, ...extra parts]; a trailing { anchor } object sets the badge position. */
const split = (c, box) => (continent, rows) =>
  rows.map(([id, name, site, ...extra]) => {
    const opts = typeof extra[extra.length - 1] === 'object' && !extra[extra.length - 1].c ? extra.pop() : {};
    return {
      id,
      name,
      continent,
      ...(typeof site[0] === 'number' ? { site } : { sites: site }),
      parts: [{ c, split: true, ...(box ? { box } : {}) }, ...extra],
      ...opts,
    };
  });
const t = (id, name, continent, parts, extra = {}) => ({ id, name, continent, parts, ...extra });

const CANADA = split('124');
const GREENLAND = split('304');
const USA = split('840', [-130, -65, 24, 50]);
const ALASKA = split('840', [-180, -129, 50, 75]);
const MEXICO = split('484');
const COLOMBIA = split('170');
const VENEZUELA = split('862');
const PERU = split('604');
const BOLIVIA = split('068');
const BRAZIL = split('076');
const ARGENTINA = split('032');
const CHILE = split('152');
const UK = (continent, rows) => rows.map((r) => ({ ...split('826')(continent, [r])[0], parts: [{ c: '826', split: true, drop: [-8.5, -5.3, 53.9, 55.5] }] }));
const NORWAY = split('578', [0, 35, 55, 72]);
const SWEDEN = split('752');
const FINLAND = split('246');
const POLAND = split('616');
const GERMANY = split('276');
const FRANCE = split('250', [-6, 10, 41, 52]);
const SPAIN = split('724', [-10, 5, 35, 44]);
const ITALY = split('380');
const UKRAINE = split('804');
const RUSSIA = split('643', [23, 180, 40, 82]);
const KAZAKHSTAN = split('398');
const UZBEKISTAN = split('860');
const AFGHANISTAN = split('004');
const MONGOLIA = split('496');
const CHINA = split('156');
const JAPAN = split('392');
const PAKISTAN = split('586');
const INDIA = split('356');
const MYANMAR = split('104');
const THAILAND = split('764');
const VIETNAM = split('704');
const INDONESIA = split('360');
const PHILIPPINES = split('608');
const PNG = split('598');
const AUSTRALIA = split('036');
const NEW_ZEALAND = split('554');
const TURKEY = split('792');
const IRAQ = split('368');
const SAUDI = split('682');
const YEMEN = split('887');
const IRAN = split('364');
const EGYPT = split('818');
const MOROCCO = split('504');
const ALGERIA = split('012');
const LIBYA = split('434');
const MAURITANIA = split('478');
const MALI = split('466');
const NIGER = split('562');
const CHAD = split('148');
const SUDAN = split('729');
const ETHIOPIA = split('231');
const SOMALIA = split('706');
const KENYA = split('404');
const TANZANIA = split('834');
const DRC = split('180');
const CAMEROON = split('120');
const CAR = split('140');
const NIGERIA = split('566');
const ANGOLA = split('024');
const ZAMBIA = split('894');
const MOZAMBIQUE = split('508');
const NAMIBIA = split('516');
const SOUTH_AFRICA = split('710', [15, 34, -36, -22]);
const MADAGASCAR = split('450');

export default {
  id: 'earth',
  name: 'Earth (440)',
  maxPlayers: 100,
  source: 'countries-50m',
  simplify: 0.01,
  minArea: 0.5,
  width: 3000,
  densify: 1,
  continents: [
    // North America
    { id: 'alaska_yukon', name: 'Alaska & Yukon' },
    { id: 'arctic', name: 'Arctic' },
    { id: 'western_canada', name: 'Western Canada' },
    { id: 'eastern_canada', name: 'Eastern Canada' },
    { id: 'pacific_states', name: 'Pacific States' },
    { id: 'mountain_west', name: 'Mountain West' },
    { id: 'great_plains', name: 'Great Plains' },
    { id: 'midwest', name: 'Midwest' },
    { id: 'northeast_us', name: 'Northeast' },
    { id: 'south_us', name: 'The South' },
    { id: 'southeast_us', name: 'Southeast' },
    { id: 'northern_mexico', name: 'Northern Mexico' },
    { id: 'southern_mexico', name: 'Southern Mexico' },
    { id: 'central_america', name: 'Central America' },
    { id: 'caribbean', name: 'Caribbean' },
    // South America
    { id: 'gran_colombia', name: 'Gran Colombia' },
    { id: 'amazonia', name: 'Amazonia' },
    { id: 'andes', name: 'Andes' },
    { id: 'brazil_northeast', name: 'Brazilian Northeast' },
    { id: 'central_brazil', name: 'Central Brazil' },
    { id: 'rio_de_la_plata', name: 'Río de la Plata' },
    { id: 'argentina_chile', name: 'Argentina & Chile' },
    { id: 'patagonia', name: 'Patagonia' },
    // Europe
    { id: 'british_isles', name: 'British Isles' },
    { id: 'scandinavia', name: 'Scandinavia' },
    { id: 'baltic', name: 'Baltic' },
    { id: 'france_benelux', name: 'France & Benelux' },
    { id: 'iberia', name: 'Iberia' },
    { id: 'germany_alps', name: 'Germany & Alps' },
    { id: 'eastern_europe', name: 'Eastern Europe' },
    { id: 'italy', name: 'Italy' },
    { id: 'balkans', name: 'Balkans' },
    { id: 'ukraine_belarus', name: 'Ukraine & Belarus' },
    // Russia and the Caucasus
    { id: 'russian_north', name: 'Russian North' },
    { id: 'central_russia', name: 'Central Russia' },
    { id: 'caucasus', name: 'Caucasus' },
    { id: 'urals', name: 'Urals' },
    { id: 'siberia', name: 'Siberia' },
    { id: 'yakutia', name: 'Yakutia' },
    { id: 'russian_far_east', name: 'Russian Far East' },
    // Asia
    { id: 'kazakhstan', name: 'Kazakhstan' },
    { id: 'turkestan', name: 'Turkestan' },
    { id: 'mongolia', name: 'Mongolia' },
    { id: 'western_china', name: 'Western China' },
    { id: 'northern_china', name: 'Northern China' },
    { id: 'central_china', name: 'Central China' },
    { id: 'south_china', name: 'South China' },
    { id: 'japan_korea', name: 'Japan & Korea' },
    { id: 'pakistan', name: 'Pakistan' },
    { id: 'north_india', name: 'North India' },
    { id: 'east_india', name: 'East India' },
    { id: 'south_india', name: 'South India' },
    { id: 'burma_siam', name: 'Burma & Siam' },
    { id: 'indochina', name: 'Indochina' },
    { id: 'sunda', name: 'Sunda Islands' },
    { id: 'philippines_moluccas', name: 'Philippines & Moluccas' },
    // Oceania
    { id: 'western_australia', name: 'Western Australia' },
    { id: 'eastern_australia', name: 'Eastern Australia' },
    { id: 'oceania', name: 'Oceania' },
    // Middle East
    { id: 'anatolia', name: 'Anatolia' },
    { id: 'levant', name: 'Levant & Mesopotamia' },
    { id: 'arabia', name: 'Arabia' },
    { id: 'southern_arabia', name: 'Southern Arabia' },
    { id: 'persia', name: 'Persia' },
    // Africa
    { id: 'maghreb', name: 'Maghreb' },
    { id: 'sahara', name: 'Sahara' },
    { id: 'nile', name: 'Nile' },
    { id: 'sahel', name: 'Sahel' },
    { id: 'west_africa', name: 'West Africa' },
    { id: 'nigeria_cameroon', name: 'Nigeria & Cameroon' },
    { id: 'equatorial_africa', name: 'Equatorial Africa' },
    { id: 'congo', name: 'Congo' },
    { id: 'horn_of_africa', name: 'Horn of Africa' },
    { id: 'east_africa', name: 'East Africa' },
    { id: 'angola_zambia', name: 'Angola & Zambia' },
    { id: 'zambezi', name: 'Zambezi' },
    { id: 'southern_africa', name: 'Southern Africa' },
  ],
  /**
   * Tournament arenas: round-one tables of about 4 players, each a group of neighbouring regions
   * that plays as a game of its own. Later rounds join neighbouring arenas (docs/tournament.md).
   */
  arenas: [
    { id: 'canada', name: 'Canada & the Arctic', regions: ['alaska_yukon', 'arctic', 'western_canada', 'eastern_canada'] },
    { id: 'american_west', name: 'American West', regions: ['pacific_states', 'mountain_west', 'great_plains'] },
    { id: 'american_east', name: 'American East', regions: ['midwest', 'northeast_us', 'south_us', 'southeast_us'] },
    { id: 'mexico_caribbean', name: 'Mexico & Caribbean', regions: ['northern_mexico', 'southern_mexico', 'central_america', 'caribbean'] },
    { id: 'andes_arena', name: 'Gran Colombia & Andes', regions: ['gran_colombia', 'andes'] },
    { id: 'brazil', name: 'Brazil', regions: ['amazonia', 'brazil_northeast', 'central_brazil'] },
    { id: 'southern_cone', name: 'Southern Cone', regions: ['rio_de_la_plata', 'argentina_chile', 'patagonia'] },
    { id: 'nordic', name: 'Nordic', regions: ['british_isles', 'scandinavia', 'baltic'] },
    { id: 'western_europe', name: 'Western Europe', regions: ['france_benelux', 'iberia', 'germany_alps'] },
    { id: 'southern_europe', name: 'Southern Europe', regions: ['italy', 'balkans', 'eastern_europe'] },
    { id: 'russia_west', name: 'European Russia', regions: ['ukraine_belarus', 'russian_north', 'central_russia'] },
    { id: 'near_east', name: 'Near East', regions: ['caucasus', 'anatolia', 'levant', 'persia'] },
    { id: 'central_asia', name: 'Central Asia', regions: ['urals', 'kazakhstan', 'turkestan'] },
    { id: 'siberia_arena', name: 'Siberia', regions: ['siberia', 'yakutia', 'russian_far_east'] },
    { id: 'china_north', name: 'Northern China & Mongolia', regions: ['mongolia', 'western_china', 'northern_china'] },
    { id: 'china_south', name: 'Southern China & Japan', regions: ['central_china', 'south_china', 'japan_korea'] },
    { id: 'india_west', name: 'India & Pakistan', regions: ['pakistan', 'north_india', 'south_india'] },
    { id: 'bengal_indochina', name: 'Bengal & Indochina', regions: ['east_india', 'burma_siam', 'indochina'] },
    { id: 'east_indies', name: 'East Indies', regions: ['sunda', 'philippines_moluccas'] },
    { id: 'australasia', name: 'Australasia', regions: ['western_australia', 'eastern_australia', 'oceania'] },
    { id: 'arabia_horn', name: 'Arabia & the Horn', regions: ['arabia', 'southern_arabia', 'horn_of_africa'] },
    { id: 'north_africa', name: 'North Africa', regions: ['maghreb', 'sahara', 'nile'] },
    { id: 'west_africa_arena', name: 'West Africa', regions: ['sahel', 'west_africa'] },
    { id: 'central_africa', name: 'Central Africa', regions: ['nigeria_cameroon', 'equatorial_africa', 'congo'] },
    { id: 'east_africa_arena', name: 'East Africa', regions: ['east_africa', 'zambezi'] },
    { id: 'southern_africa_arena', name: 'Southern Africa', regions: ['angola_zambia', 'southern_africa'] },
  ],
  territories: [
    // ---- North America ----
    ...ALASKA('alaska_yukon', [
      ['north_alaska', 'North Alaska', [-153, 67]],
      ['south_alaska', 'South Alaska', [[-152, 61.5], [-160, 58], [-136, 58]]],
    ]),
    ...CANADA('alaska_yukon', [
      ['yukon', 'Yukon', [-135, 63]],
      ['northwest_territories', 'Northwest Territories', [-119, 64]],
    ]),
    ...CANADA('arctic', [
      ['kivalliq', 'Kivalliq', [-95, 63]],
      ['arctic_islands', 'Arctic Islands', [[-108, 72], [-92, 77]]],
      ['baffin', 'Baffin Island', [[-72, 69], [-80, 73]]],
    ]),
    ...GREENLAND('arctic', [
      ['north_greenland', 'North Greenland', [-40, 79]],
      ['west_greenland', 'West Greenland', [-50, 68]],
      ['east_greenland', 'East Greenland', [-34, 68]],
    ]),
    ...CANADA('western_canada', [
      ['british_columbia', 'British Columbia', [-125, 54]],
      ['alberta', 'Alberta', [-114, 55]],
      ['saskatchewan', 'Saskatchewan', [-106, 54.5]],
      ['manitoba', 'Manitoba', [-97, 55]],
    ]),
    ...CANADA('eastern_canada', [
      ['northern_ontario', 'Northern Ontario', [-87, 51.5]],
      ['southern_ontario', 'Southern Ontario', [-80.5, 45.5]],
      ['northern_quebec', 'Northern Quebec', [-73, 55.5]],
      ['southern_quebec', 'Southern Quebec', [-72, 48.5]],
      ['labrador', 'Labrador', [-61, 53.5]],
      ['maritimes', 'Maritimes', [-64.5, 46]],
      ['newfoundland', 'Newfoundland', [-56, 49]],
    ]),
    ...USA('pacific_states', [
      ['washington', 'Washington', [-120.5, 47.4]],
      ['oregon', 'Oregon', [-120.5, 44]],
      ['northern_california', 'Northern California', [-121.5, 39.5]],
      ['southern_california', 'Southern California', [-117, 34.6]],
      ['nevada', 'Nevada', [-116.8, 39.3]],
    ]),
    t('hawaii', 'Hawaii', 'pacific_states', [{ c: '840', box: [-162, -154, 18, 23] }]),
    ...USA('mountain_west', [
      ['idaho', 'Idaho', [-114.6, 44.6]],
      ['montana', 'Montana', [-109.5, 47]],
      ['wyoming', 'Wyoming', [-107.5, 43]],
      ['utah', 'Utah', [-111.6, 39.4]],
      ['colorado', 'Colorado', [-105.5, 39]],
      ['arizona', 'Arizona', [-111.7, 34.2]],
      ['new_mexico', 'New Mexico', [-106, 34.4]],
    ]),
    ...USA('great_plains', [
      ['north_dakota', 'North Dakota', [-100.5, 47.5]],
      ['south_dakota', 'South Dakota', [-100.2, 44.4]],
      ['nebraska', 'Nebraska', [-99.8, 41.5]],
      ['kansas', 'Kansas', [-98.4, 38.5]],
      ['oklahoma', 'Oklahoma', [-97.5, 35.5]],
      ['minnesota', 'Minnesota', [-94.3, 46.3]],
      ['iowa', 'Iowa', [-93.5, 42]],
    ]),
    ...USA('midwest', [
      ['wisconsin', 'Wisconsin', [-89.8, 44.6]],
      ['illinois', 'Illinois', [-89.2, 40]],
      ['michigan', 'Michigan', [-85, 44.5]],
      ['ohio_valley', 'Ohio & Indiana', [-84.3, 40.2]],
    ]),
    ...USA('northeast_us', [
      ['pennsylvania', 'Pennsylvania', [-77.6, 40.9]],
      ['new_york', 'New York', [-75.5, 43]],
      ['new_england', 'New England', [-71, 44]],
    ]),
    ...USA('south_us', [
      ['west_texas', 'West Texas', [-101.5, 31.5]],
      ['east_texas', 'East Texas', [-96, 30.5]],
      ['missouri', 'Missouri', [-92.5, 38.4]],
      ['arkansas_louisiana', 'Arkansas & Louisiana', [-92.3, 33]],
      ['tennessee_kentucky', 'Tennessee & Kentucky', [-86.5, 36.4]],
      ['mississippi_alabama', 'Mississippi & Alabama', [-88.8, 32.7]],
    ]),
    ...USA('southeast_us', [
      ['georgia', 'Georgia', [-83.4, 32.7]],
      ['florida', 'Florida', [-81.6, 28.3]],
      ['carolinas', 'Carolinas', [-79.5, 35.3]],
      ['virginias', 'Virginias', [-79, 38.2]],
    ]),
    ...MEXICO('northern_mexico', [
      ['baja_california', 'Baja California', [[-115.5, 31], [-113, 27.5], [-110.5, 24]]],
      ['sonora', 'Sonora', [-110.5, 29.5]],
      ['chihuahua', 'Chihuahua', [-106, 28.5]],
      ['northeast_mexico', 'Northeast Mexico', [-100, 26.5]],
      ['bajio', 'Bajío', [-102, 22.5]],
    ]),
    ...MEXICO('southern_mexico', [
      ['jalisco', 'Jalisco', [-104.5, 20]],
      ['mexico_city', 'Mexico City', [-99, 19.5]],
      ['oaxaca', 'Oaxaca', [-96.5, 17]],
      ['yucatan', 'Yucatán', [-89.5, 19.5]],
    ]),
    t('guatemala_belize', 'Guatemala & Belize', 'central_america', ['320', '084']),
    t('honduras_salvador', 'Honduras & El Salvador', 'central_america', ['340', '222']),
    t('nicaragua', 'Nicaragua', 'central_america', ['558']),
    t('costa_rica_panama', 'Costa Rica & Panama', 'central_america', ['188', '591']),
    t('cuba', 'Cuba', 'caribbean', ['192', '044']),
    t('hispaniola', 'Hispaniola', 'caribbean', ['332', '214']),
    t('jamaica', 'Jamaica', 'caribbean', ['388']),
    t('puerto_rico', 'Puerto Rico', 'caribbean', ['630']),
    t('trinidad', 'Trinidad & Tobago', 'caribbean', ['780']),

    // ---- South America ----
    ...COLOMBIA('gran_colombia', [
      ['caribbean_colombia', 'Caribbean Colombia', [-74.5, 9.5]],
      ['andean_colombia', 'Andean Colombia', [-75.5, 5]],
      ['llanos', 'Llanos', [-71, 4.5]],
      ['colombian_amazon', 'Colombian Amazon', [-72, 0]],
    ]),
    ...VENEZUELA('gran_colombia', [
      ['maracaibo', 'Maracaibo', [-71.5, 9.5]],
      ['caracas', 'Caracas', [-66.5, 9.5]],
      ['guayana', 'Guayana', [-63.5, 5.5]],
    ]),
    t('ecuador', 'Ecuador', 'gran_colombia', ['218']),
    t('guyana', 'Guyana', 'amazonia', ['328']),
    t('suriname', 'Suriname & Guiana', 'amazonia', ['740', { c: '250', box: [-60, -50, 0, 10] }]),
    ...BRAZIL('amazonia', [
      ['roraima', 'Roraima', [-61.5, 2]],
      ['amapa', 'Amapá', [-52, 1.5]],
      ['acre', 'Acre', [-69.5, -6]],
      ['amazonas', 'Amazonas', [-62.5, -3.5]],
      ['para', 'Pará', [-52.5, -4.5]],
      ['rondonia', 'Rondônia', [-63, -11]],
    ]),
    ...PERU('andes', [
      ['northern_peru', 'Northern Peru', [-79, -6.5]],
      ['loreto', 'Loreto', [-74.5, -4]],
      ['lima', 'Lima', [-76.3, -11.5]],
      ['cusco', 'Cusco', [-72, -14.5]],
    ]),
    ...BOLIVIA('andes', [
      ['altiplano', 'Altiplano', [-67.8, -17.5]],
      ['santa_cruz', 'Santa Cruz', [-62.5, -16.5]],
    ]),
    ...BRAZIL('brazil_northeast', [
      ['maranhao', 'Maranhão', [-45, -5.5]],
      ['sertao', 'Sertão', [-39.5, -6.5]],
      ['bahia', 'Bahia', [-41.5, -12.5]],
      ['tocantins', 'Tocantins', [-48.3, -10]],
    ]),
    ...BRAZIL('central_brazil', [
      ['mato_grosso', 'Mato Grosso', [-55.5, -13]],
      ['goias', 'Goiás', [-49.5, -16]],
      ['minas_gerais', 'Minas Gerais', [-44, -19]],
      ['pantanal', 'Pantanal', [-54.5, -20.5]],
    ]),
    ...BRAZIL('rio_de_la_plata', [
      ['sao_paulo', 'São Paulo', [-48.5, -22.5]],
      ['parana', 'Paraná', [-51, -26]],
      ['rio_grande_do_sul', 'Rio Grande do Sul', [-53.5, -29.5]],
    ]),
    t('paraguay', 'Paraguay', 'rio_de_la_plata', ['600']),
    t('uruguay', 'Uruguay', 'rio_de_la_plata', ['858']),
    ...ARGENTINA('argentina_chile', [
      ['salta', 'Salta', [-65.5, -24.5]],
      ['gran_chaco', 'Gran Chaco', [-60.5, -26.5]],
      ['cuyo', 'Cuyo', [-68.5, -32.5]],
      ['cordoba', 'Córdoba', [-63.8, -31.8]],
      ['buenos_aires', 'Buenos Aires', [-60, -36.5]],
    ]),
    ...CHILE('argentina_chile', [
      ['atacama', 'Atacama', [[-69.5, -21], [-70.2, -26.5]]],
      ['central_chile', 'Central Chile', [-71, -33.5]],
    ]),
    ...ARGENTINA('patagonia', [
      ['north_patagonia', 'North Patagonia', [-68, -39.5]],
      ['south_patagonia', 'South Patagonia', [[-69.5, -45], [-69, -50], [-67.5, -54]]],
    ]),
    ...CHILE('patagonia', [
      ['los_lagos', 'Los Lagos', [-72.5, -40]],
      ['magallanes', 'Magallanes', [[-73.5, -47], [-72.5, -51.5], [-70, -54.5]]],
    ]),
    t('falklands', 'Falkland Islands', 'patagonia', ['238']),

    // ---- Europe ----
    ...UK('british_isles', [
      ['scotland', 'Scotland', [-4.5, 57], { anchor: [-4.3, 57.4] }],
      ['northern_england', 'Northern England', [-2, 54.4], { anchor: [-2.3, 54.7] }],
      ['southern_england', 'Southern England', [-1, 51.7], { anchor: [-1.2, 51.6] }],
    ]),
    t('ireland', 'Ireland', 'british_isles', ['372', { c: '826', pick: [-8.5, -5.3, 53.9, 55.5] }]),
    t('iceland', 'Iceland', 'british_isles', ['352']),
    ...NORWAY('scandinavia', [
      ['southern_norway', 'Southern Norway', [8.5, 60.5], { anchor: [8.8, 60.6] }],
      ['trondelag', 'Trøndelag', [12, 64.5], { anchor: [12.6, 65] }],
      ['northern_norway', 'Northern Norway', [20, 69]],
    ]),
    t('svalbard', 'Svalbard', 'scandinavia', [{ c: '578', box: [0, 35, 74, 81] }]),
    ...SWEDEN('scandinavia', [
      ['svealand', 'Svealand', [15.5, 58.8]],
      ['norrland', 'Norrland', [17.5, 65]],
    ]),
    t('denmark', 'Denmark', 'scandinavia', ['208']),
    ...FINLAND('baltic', [
      ['southern_finland', 'Southern Finland', [25, 61.8]],
      ['lapland', 'Lapland', [26, 67]],
    ]),
    t('estonia', 'Estonia', 'baltic', ['233'], { anchor: [26, 58.8] }),
    t('latvia', 'Latvia', 'baltic', ['428'], { anchor: [22.2, 57.1] }),
    t('lithuania', 'Lithuania', 'baltic', ['440', { c: '643', box: [19, 23, 54, 56] }], { anchor: [25.3, 55] }),
    ...FRANCE('france_benelux', [
      ['northwest_france', 'Northwest France', [-1, 48]],
      ['northeast_france', 'Northeast France', [4.5, 48.8]],
      ['southwest_france', 'Southwest France', [0.5, 44.3]],
      ['southeast_france', 'Southeast France', [5.2, 44.6]],
    ]),
    t('benelux', 'Benelux', 'france_benelux', [{ c: '528', box: [3, 8, 50, 54] }, '056', '442']),
    ...SPAIN('iberia', [
      ['galicia', 'Galicia & León', [-6.5, 42.5]],
      ['catalonia', 'Catalonia & Aragon', [0.5, 41.8]],
      ['castile', 'Castile', [-3.7, 40]],
      ['andalusia', 'Andalusia', [-4.8, 37.4]],
    ]),
    t('portugal', 'Portugal', 'iberia', [{ c: '620', box: [-10, -6, 36, 43] }]),
    ...GERMANY('germany_alps', [
      ['northern_germany', 'Northern Germany', [9.3, 53.3]],
      ['rhineland', 'Rhineland', [7.7, 50.6]],
      ['bavaria', 'Bavaria', [11.3, 48.6], { anchor: [11, 49.2] }],
      ['saxony', 'Saxony & Brandenburg', [13.2, 51.8]],
    ]),
    t('switzerland', 'Switzerland', 'germany_alps', ['756', '438']),
    t('austria', 'Austria', 'germany_alps', ['040'], { anchor: [14, 47.5] }),
    ...POLAND('eastern_europe', [
      ['western_poland', 'Western Poland', [16.8, 52.5]],
      ['eastern_poland', 'Eastern Poland', [21.8, 52]],
    ]),
    t('czechia_slovakia', 'Czechia & Slovakia', 'eastern_europe', ['203', '703'], { anchor: [16.5, 49.6] }),
    t('hungary', 'Hungary', 'eastern_europe', ['348'], { anchor: [19, 46.9] }),
    ...ITALY('italy', [
      ['northern_italy', 'Northern Italy', [10, 45.3]],
      ['central_italy', 'Central Italy', [12.5, 42.6]],
      ['southern_italy', 'Southern Italy', [16, 40.3]],
      ['sicily', 'Sicily', [14, 37.5]],
      ['sardinia', 'Sardinia', [9, 40]],
    ]),
    t('slovenia_croatia', 'Slovenia & Croatia', 'balkans', ['705', '191'], { anchor: [15.7, 45.4] }),
    t('bosnia_montenegro', 'Bosnia & Montenegro', 'balkans', ['070', '499'], { anchor: [18.1, 43.6] }),
    t('serbia', 'Serbia & Kosovo', 'balkans', ['688', 'Kosovo'], { anchor: [21.2, 44] }),
    t('albania_macedonia', 'Albania & Macedonia', 'balkans', ['008', '807']),
    t('greece', 'Greece', 'balkans', ['300'], { anchor: [22.2, 37.6] }),
    t('bulgaria', 'Bulgaria', 'balkans', ['100']),
    t('romania', 'Romania & Moldova', 'balkans', ['642', '498']),
    ...UKRAINE('ukraine_belarus', [
      ['western_ukraine', 'Western Ukraine', [25, 49]],
      ['kyiv', 'Kyiv', [31, 50.5]],
      ['eastern_ukraine', 'Eastern Ukraine', [37, 48.6]],
      ['southern_ukraine', 'Southern Ukraine', [32.5, 46.6]],
    ]),
    t('belarus', 'Belarus', 'ukraine_belarus', ['112']),

    // ---- Russia and the Caucasus ----
    ...RUSSIA('russian_north', [
      ['murmansk', 'Murmansk', [35, 68]],
      ['karelia', 'Karelia', [33.5, 63.5]],
      ['st_petersburg', 'St Petersburg', [31, 59]],
      ['arkhangelsk', 'Arkhangelsk', [43, 63.5]],
      ['komi', 'Komi', [54, 63.5]],
      ['nenets', 'Nenets', [[55, 68], [58, 73]]],
    ]),
    ...RUSSIA('central_russia', [
      ['moscow', 'Moscow', [37.5, 55.6]],
      ['black_earth', 'Black Earth', [39, 51.5]],
      ['nizhny_novgorod', 'Nizhny Novgorod', [44, 56.5]],
      ['kazan', 'Kazan', [50, 55.7]],
      ['samara', 'Samara & Saratov', [48, 52]],
      ['volgograd', 'Volgograd & Astrakhan', [45.5, 48.2]],
    ]),
    ...RUSSIA('caucasus', [
      ['kuban', 'Kuban', [40, 45.5]],
      ['north_caucasus', 'North Caucasus', [45.5, 43.5]],
    ]),
    t('georgia_armenia', 'Georgia & Armenia', 'caucasus', ['268', '051']),
    t('azerbaijan', 'Azerbaijan', 'caucasus', ['031']),
    ...RUSSIA('urals', [
      ['perm', 'Perm', [56.5, 59]],
      ['yekaterinburg', 'Yekaterinburg', [62, 57.5]],
      ['orenburg', 'Orenburg & Bashkiria', [56, 53]],
      ['khanty_mansi', 'Khanty-Mansi', [70, 61.5]],
      ['yamal', 'Yamal', [72, 67]],
      ['omsk', 'Omsk', [71, 56]],
    ]),
    ...RUSSIA('siberia', [
      ['novosibirsk', 'Novosibirsk', [79.5, 55]],
      ['tomsk', 'Tomsk', [82, 58.8]],
      ['altai', 'Altai', [86, 51.5]],
      ['krasnoyarsk', 'Krasnoyarsk', [93, 57]],
      ['taymyr', 'Taymyr', [[98, 72], [88, 69]]],
      ['evenkia', 'Evenkia', [100, 64]],
      ['tuva', 'Tuva', [94, 51.5]],
      ['irkutsk', 'Irkutsk', [104, 56]],
    ]),
    ...RUSSIA('yakutia', [
      ['western_yakutia', 'Western Yakutia', [117, 64]],
      ['eastern_yakutia', 'Eastern Yakutia', [[133, 63.5], [137, 70]]],
      ['magadan', 'Magadan', [151, 62.5]],
      ['chukotka', 'Chukotka', [170, 66.5]],
      ['kamchatka', 'Kamchatka', [[159, 55.5], [164, 60.5]]],
    ]),
    ...RUSSIA('russian_far_east', [
      ['buryatia', 'Buryatia', [110, 53]],
      ['chita', 'Chita', [117, 51.5]],
      ['amur', 'Amur', [127.5, 54]],
      ['khabarovsk', 'Khabarovsk', [[136, 51], [139, 57]]],
      ['primorye', 'Primorye', [134.5, 45.5]],
      ['sakhalin', 'Sakhalin', [143, 50]],
    ]),

    // ---- Central Asia ----
    ...KAZAKHSTAN('kazakhstan', [
      ['west_kazakhstan', 'West Kazakhstan', [53.5, 48]],
      ['aral', 'Aral', [63.5, 45.5]],
      ['north_kazakhstan', 'North Kazakhstan', [68.5, 52]],
      ['karaganda', 'Karaganda', [72.5, 48]],
      ['east_kazakhstan', 'East Kazakhstan', [80.5, 49]],
      ['almaty', 'Almaty', [74.5, 44]],
    ]),
    ...UZBEKISTAN('turkestan', [
      ['karakalpakstan', 'Karakalpakstan', [59, 43]],
      ['samarkand', 'Samarkand & Tashkent', [67, 40]],
    ]),
    t('turkmenistan', 'Turkmenistan', 'turkestan', ['795']),
    t('kyrgyzstan', 'Kyrgyzstan', 'turkestan', ['417']),
    t('tajikistan', 'Tajikistan', 'turkestan', ['762']),
    ...AFGHANISTAN('turkestan', [
      ['herat', 'Herat', [63.5, 33.5]],
      ['kabul', 'Kabul', [68.5, 34.5]],
    ]),
    ...MONGOLIA('mongolia', [
      ['western_mongolia', 'Western Mongolia', [94, 48]],
      ['ulaanbaatar', 'Ulaanbaatar', [104, 47]],
      ['gobi', 'Gobi', [112, 45.5]],
    ]),

    // ---- China, Japan, Korea ----
    ...CHINA('mongolia', [
      ['western_inner_mongolia', 'Western Inner Mongolia', [105.5, 41]],
      ['eastern_inner_mongolia', 'Eastern Inner Mongolia', [118.5, 45]],
    ]),
    ...CHINA('western_china', [
      ['dzungaria', 'Dzungaria', [86, 45.5]],
      ['tarim', 'Tarim', [80.5, 38.5]],
      ['hami', 'Hami', [93, 41.5]],
      ['ngari', 'Ngari', [82, 32.5]],
      ['lhasa', 'Lhasa', [90, 30.8]],
      ['qinghai', 'Qinghai', [96, 35.5]],
      ['gansu', 'Gansu', [[102.5, 37.5], [98, 40]]],
    ]),
    ...CHINA('northern_china', [
      ['heilongjiang', 'Heilongjiang', [128, 47.5]],
      ['manchuria', 'Manchuria', [124.5, 42.3]],
      ['hebei', 'Hebei', [115.5, 39]],
      ['shaanxi', 'Shaanxi & Shanxi', [110, 36]],
      ['shandong', 'Shandong', [118.5, 36.3]],
      ['henan', 'Henan', [113.5, 33.6]],
    ]),
    ...CHINA('central_china', [
      ['jiangsu', 'Jiangsu & Anhui', [119, 32]],
      ['hubei', 'Hubei', [112, 30.8]],
      ['sichuan', 'Sichuan', [103, 30.5]],
      ['guizhou', 'Guizhou', [107, 27]],
      ['hunan', 'Hunan & Jiangxi', [114, 27.3]],
    ]),
    ...CHINA('south_china', [
      ['yunnan', 'Yunnan', [101.5, 24.5]],
      ['fujian', 'Fujian & Zhejiang', [119, 27]],
      ['guangdong', 'Guangdong', [113.5, 23.6]],
      ['guangxi', 'Guangxi', [108.5, 23.6]],
      ['hainan', 'Hainan', [109.8, 19.2]],
    ]),
    t('taiwan', 'Taiwan', 'south_china', ['158']),
    t('north_korea', 'North Korea', 'japan_korea', ['408']),
    t('south_korea', 'South Korea', 'japan_korea', ['410']),
    ...JAPAN('japan_korea', [
      ['hokkaido', 'Hokkaido', [143, 43.5]],
      ['tohoku', 'Tōhoku', [140.6, 39.5]],
      ['kanto', 'Kantō', [138.6, 36]],
      ['kansai', 'Kansai', [134, 34.8], { anchor: [134.8, 35] }],
      ['kyushu', 'Kyūshū', [130.8, 32.5], { anchor: [130.7, 32.3] }],
    ]),

    // ---- South Asia ----
    ...PAKISTAN('pakistan', [
      ['khyber', 'Khyber', [72.5, 35]],
      ['punjab', 'Punjab', [72.5, 31]],
      ['sindh', 'Sindh', [68.5, 26]],
      ['balochistan', 'Balochistan', [65.5, 28.3]],
    ]),
    ...INDIA('north_india', [
      ['kashmir', 'Kashmir', [76.5, 34]],
      ['haryana', 'Haryana & Punjab', [75.8, 30.5]],
      ['rajasthan', 'Rajasthan', [73.3, 26.5]],
      ['gujarat', 'Gujarat', [71.5, 22.6]],
      ['uttar_pradesh', 'Uttar Pradesh', [80.5, 27]],
      ['madhya_pradesh', 'Madhya Pradesh', [78, 23.5]],
    ]),
    t('nepal', 'Nepal', 'north_india', ['524']),
    ...INDIA('east_india', [
      ['bihar', 'Bihar', [85.2, 25.2]],
      ['west_bengal', 'West Bengal', [88, 23.3]],
      ['odisha', 'Odisha', [84.5, 20.3]],
      ['chhattisgarh', 'Chhattisgarh', [81.8, 21.5]],
      ['assam', 'Assam & Bhutan', [93, 26]],
    ]),
    t('bangladesh', 'Bangladesh', 'east_india', ['050']),
    ...INDIA('south_india', [
      ['maharashtra', 'Maharashtra', [75.5, 19.5]],
      ['andhra', 'Andhra & Telangana', [79.5, 16.5]],
      ['karnataka', 'Karnataka', [75.8, 14.3]],
      ['tamil_nadu', 'Tamil Nadu & Kerala', [78.2, 10.8]],
    ]),
    t('sri_lanka', 'Sri Lanka', 'south_india', ['144']),

    // ---- Southeast Asia ----
    ...MYANMAR('burma_siam', [
      ['kachin', 'Kachin', [97, 25]],
      ['mandalay', 'Mandalay', [95.7, 21.5]],
      ['yangon', 'Yangon', [[96.2, 17.5], [98.6, 12.5]]],
    ]),
    ...THAILAND('burma_siam', [
      ['chiang_mai', 'Chiang Mai', [99.6, 17.5]],
      ['isan', 'Isan', [103, 15.8]],
      ['southern_thailand', 'Southern Thailand', [[100.3, 12.5], [99.5, 8.5]]],
    ]),
    t('laos', 'Laos', 'indochina', ['418']),
    t('cambodia', 'Cambodia', 'indochina', ['116']),
    ...VIETNAM('indochina', [
      ['tonkin', 'Tonkin', [105.5, 21.3]],
      ['cochinchina', 'Annam & Cochinchina', [[108, 15], [106.5, 11]]],
    ]),
    t('malaya', 'Malaya', 'indochina', [{ c: '458', box: [99, 105, 0, 8] }, '702']),
    ...INDONESIA('sunda', [
      ['aceh', 'Aceh & North Sumatra', [98.5, 3]],
      ['south_sumatra', 'South Sumatra', [103, -2.5]],
      ['west_java', 'West Java', [107, -6.9]],
      ['east_java', 'East Java', [111.8, -7.5]],
      ['kalimantan', 'Kalimantan', [113.5, -1]],
      ['nusa_tenggara', 'Nusa Tenggara', [[118, -8.7], [123.5, -9.5]]],
    ]),
    t('sabah_sarawak', 'Sabah & Sarawak', 'sunda', [{ c: '458', box: [108, 120, 0, 8] }, '096']),
    ...INDONESIA('philippines_moluccas', [
      ['sulawesi', 'Sulawesi', [121, -2]],
      ['maluku', 'Maluku', [128.5, -2.5]],
      ['papua', 'Papua', [138, -4]],
    ]),
    ...PHILIPPINES('philippines_moluccas', [
      ['luzon', 'Luzon', [121, 16.5]],
      ['visayas', 'Visayas', [123.5, 11]],
      ['mindanao', 'Mindanao', [125, 7.5]],
    ]),

    // ---- Oceania ----
    ...AUSTRALIA('western_australia', [
      ['kimberley', 'Kimberley', [126, -17.5]],
      ['pilbara', 'Pilbara', [119.5, -23]],
      ['perth', 'Perth & Goldfields', [119, -30.5]],
      ['top_end', 'Top End', [133, -14.5]],
      ['red_centre', 'Red Centre', [132.5, -23.5]],
    ]),
    ...AUSTRALIA('eastern_australia', [
      ['cape_york', 'Cape York', [143.5, -16]],
      ['queensland', 'Queensland', [145.5, -23.5]],
      ['south_australia', 'South Australia', [135.5, -30.5]],
      ['new_south_wales', 'New South Wales', [147, -32]],
      ['victoria', 'Victoria', [144.5, -37]],
      ['tasmania', 'Tasmania', [146.5, -42]],
    ]),
    ...PNG('oceania', [
      ['new_guinea', 'New Guinea', [144.5, -6]],
      ['new_britain', 'New Britain', [151, -5]],
    ]),
    t('solomon_islands', 'Solomon Islands', 'oceania', ['090']),
    t('new_caledonia', 'New Caledonia', 'oceania', ['540', '548']),
    t('fiji', 'Fiji', 'oceania', ['242']),
    ...NEW_ZEALAND('oceania', [
      ['north_island', 'North Island', [175.5, -38.5]],
      ['south_island', 'South Island', [170.5, -44]],
    ]),

    // ---- Middle East ----
    ...TURKEY('anatolia', [
      ['western_turkey', 'Western Turkey', [29, 39.8]],
      ['central_anatolia', 'Central Anatolia', [34, 38.8]],
      ['eastern_anatolia', 'Eastern Anatolia', [40.5, 39]],
    ]),
    t('cyprus', 'Cyprus', 'anatolia', ['196', 'N. Cyprus']),
    t('syria', 'Syria', 'levant', ['760']),
    t('holy_land', 'Holy Land', 'levant', ['422', '376', '275', '400']),
    ...IRAQ('levant', [
      ['mosul', 'Mosul', [43.5, 35.5]],
      ['baghdad', 'Baghdad & Basra', [45.5, 32]],
    ]),
    ...SAUDI('arabia', [
      ['northern_arabia', 'Northern Arabia', [40.5, 28.5]],
      ['hejaz', 'Hejaz', [40, 23]],
      ['najd', 'Najd', [45, 25]],
      ['asir', 'Asir', [44, 18.5]],
    ]),
    t('eastern_arabia', 'Eastern Arabia', 'arabia', [{ c: '682', split: true }, '414', '634', '048'], { sites: [[50, 22.5], [49.5, 26]] }),
    ...YEMEN('southern_arabia', [
      ['sanaa', "Sana'a", [44.5, 15]],
      ['hadramawt', 'Hadramawt', [49, 16]],
    ]),
    t('oman', 'Oman', 'southern_arabia', ['512']),
    t('emirates', 'Emirates', 'southern_arabia', ['784']),
    ...IRAN('persia', [
      ['tehran', 'Tehran', [51.5, 35.5]],
      ['tabriz', 'Tabriz', [47, 37.5]],
      ['khuzestan', 'Khuzestan', [48.5, 32]],
      ['fars', 'Fars', [53, 29]],
      ['khorasan', 'Khorasan', [58.5, 35]],
      ['baluchestan', 'Baluchestan', [59.5, 28]],
    ]),

    // ---- Africa ----
    ...MOROCCO('maghreb', [
      ['northern_morocco', 'Northern Morocco', [-5.5, 33.5]],
      ['southern_morocco', 'Southern Morocco', [-8.5, 29.8]],
    ]),
    t('western_sahara', 'Western Sahara', 'maghreb', ['732']),
    ...ALGERIA('maghreb', [['northern_algeria', 'Northern Algeria', [3, 35.3]]]),
    t('tunisia', 'Tunisia', 'maghreb', ['788']),
    ...LIBYA('maghreb', [['tripolitania', 'Tripolitania', [13.5, 31]]]),
    ...ALGERIA('sahara', [
      ['western_algeria', 'Western Algeria', [-2, 28.5]],
      ['eastern_algeria', 'Eastern Algeria', [7, 29.5]],
      ['hoggar', 'Hoggar', [5.5, 23]],
    ]),
    ...LIBYA('sahara', [
      ['fezzan', 'Fezzan', [14, 25.5]],
      ['cyrenaica', 'Cyrenaica', [21.5, 29]],
    ]),
    ...EGYPT('nile', [
      ['lower_egypt', 'Lower Egypt & Sinai', [31.5, 30]],
      ['upper_egypt', 'Upper Egypt', [32.5, 25]],
      ['western_desert', 'Western Desert', [27.5, 26]],
    ]),
    ...SUDAN('nile', [
      ['nubia', 'Nubia', [31, 19]],
      ['khartoum', 'Khartoum', [32.5, 14]],
    ]),
    ...SUDAN('sahel', [['darfur', 'Darfur', [24.5, 13]]]),
    ...MAURITANIA('sahel', [
      ['northern_mauritania', 'Northern Mauritania', [-11.5, 22]],
      ['southern_mauritania', 'Southern Mauritania', [-12, 17.8]],
    ]),
    ...MALI('sahel', [
      ['timbuktu', 'Timbuktu', [-1.5, 19]],
      ['bamako', 'Bamako', [-7, 13]],
    ]),
    ...NIGER('sahel', [
      ['agadez', 'Agadez', [9, 18.5]],
      ['niamey', 'Niamey & Zinder', [5.5, 14]],
    ]),
    ...CHAD('sahel', [
      ['tibesti', 'Tibesti', [18, 18.5]],
      ['ndjamena', "N'Djamena", [18.5, 11.5]],
    ]),
    t('senegal', 'Senegal & Gambia', 'west_africa', ['686', '270']),
    t('guinea', 'Guinea', 'west_africa', ['324', '624']),
    t('sierra_leone', 'Sierra Leone', 'west_africa', ['694']),
    t('liberia', 'Liberia', 'west_africa', ['430']),
    t('ivory_coast', 'Ivory Coast', 'west_africa', ['384']),
    t('burkina_faso', 'Burkina Faso', 'west_africa', ['854']),
    t('ghana', 'Ghana', 'west_africa', ['288']),
    t('togo_benin', 'Togo & Benin', 'west_africa', ['768', '204']),
    ...NIGERIA('nigeria_cameroon', [
      ['kano', 'Kano & Sokoto', [6.5, 12.2]],
      ['borno', 'Borno', [12, 11]],
      ['abuja', 'Abuja', [8.5, 9]],
      ['lagos', 'Lagos', [4, 7.6]],
      ['niger_delta', 'Niger Delta', [7.3, 5.6]],
    ]),
    ...CAMEROON('nigeria_cameroon', [
      ['northern_cameroon', 'Northern Cameroon', [14, 9.5]],
      ['southern_cameroon', 'Southern Cameroon', [11.8, 4]],
    ]),
    ...CAR('equatorial_africa', [
      ['western_car', 'Western Central Africa', [17.5, 6]],
      ['eastern_car', 'Eastern Central Africa', [23, 6.8]],
    ]),
    t('gabon', 'Gabon', 'equatorial_africa', ['266', '226']),
    t('congo_brazzaville', 'Congo-Brazzaville', 'equatorial_africa', ['178']),
    ...DRC('equatorial_africa', [['equateur', 'Équateur', [20, 0.5]]]),
    ...DRC('congo', [
      ['kinshasa', 'Kinshasa', [16, -5]],
      ['kasai', 'Kasai', [22.5, -5.5]],
      ['katanga', 'Katanga', [26.5, -9.5]],
      ['kivu', 'Kivu', [27.5, -2.8]],
      ['ituri', 'Ituri', [27, 2.5]],
    ]),
    ...ETHIOPIA('horn_of_africa', [
      ['amhara', 'Amhara & Tigray', [38.5, 12.5]],
      ['oromia', 'Oromia', [38.2, 8.3]],
      ['ogaden', 'Ogaden', [43.5, 6.8]],
    ]),
    t('eritrea', 'Eritrea', 'horn_of_africa', ['232']),
    t('somaliland', 'Somaliland & Djibouti', 'horn_of_africa', ['Somaliland', '262']),
    ...SOMALIA('horn_of_africa', [
      ['puntland', 'Puntland', [48.5, 8.5]],
      ['southern_somalia', 'Southern Somalia', [44.5, 2.5]],
    ]),
    t('south_sudan', 'South Sudan', 'east_africa', ['728']),
    t('uganda', 'Uganda', 'east_africa', ['800']),
    t('rwanda_burundi', 'Rwanda & Burundi', 'east_africa', ['646', '108']),
    ...KENYA('east_africa', [
      ['northern_kenya', 'Northern Kenya', [38.5, 2.5]],
      ['nairobi', 'Nairobi & Mombasa', [37.8, -1.8]],
    ]),
    ...TANZANIA('east_africa', [
      ['northern_tanzania', 'Northern Tanzania', [34.5, -4]],
      ['southern_tanzania', 'Southern Tanzania', [36, -9]],
    ]),
    ...ANGOLA('angola_zambia', [
      ['luanda', 'Luanda', [14.8, -8.5]],
      ['lunda', 'Lunda', [20.5, -9]],
      ['huambo', 'Huambo', [15.5, -13.5]],
      ['cuando_cubango', 'Cuando Cubango', [20, -16]],
    ]),
    ...ZAMBIA('angola_zambia', [
      ['northern_zambia', 'Northern Zambia', [30, -11]],
      ['lusaka', 'Lusaka & Barotseland', [25.5, -15]],
    ]),
    t('malawi', 'Malawi', 'zambezi', ['454']),
    t('zimbabwe', 'Zimbabwe', 'zambezi', ['716']),
    ...MOZAMBIQUE('zambezi', [
      ['northern_mozambique', 'Northern Mozambique', [38, -13.5]],
      ['sofala', 'Sofala & Tete', [34, -18]],
      ['maputo', 'Maputo & Gaza', [33, -23.5]],
    ]),
    ...MADAGASCAR('zambezi', [
      ['northern_madagascar', 'Northern Madagascar', [47.5, -15.5]],
      ['southern_madagascar', 'Southern Madagascar', [45.5, -22.5]],
    ]),
    t('botswana', 'Botswana', 'southern_africa', ['072']),
    ...NAMIBIA('southern_africa', [
      ['northern_namibia', 'Northern Namibia', [17.5, -19.5]],
      ['southern_namibia', 'Southern Namibia', [17, -25.5]],
    ]),
    ...SOUTH_AFRICA('southern_africa', [
      ['western_cape', 'Western Cape', [20, -33]],
      ['northern_cape', 'Northern Cape', [21.5, -29]],
      ['transvaal', 'Transvaal & eSwatini', [28.5, -24.8], '748'],
      ['natal', 'Natal & Lesotho', [28.5, -30.5], '426'],
    ]),
  ],
  /** Crossings over water. Land borders are found from the shapes. */
  seaLanes: [
    // North Pacific and the Arctic
    ['north_alaska', 'chukotka'],
    ['hawaii', 'southern_california'], ['hawaii', 'northern_california'], ['hawaii', 'fiji'],
    ['arctic_islands', 'north_greenland'],
    ['baffin', 'northern_quebec'], ['baffin', 'west_greenland'],
    ['west_greenland', 'labrador'], ['east_greenland', 'iceland'], ['north_greenland', 'svalbard'],
    ['newfoundland', 'maritimes'], ['newfoundland', 'southern_quebec'],
    // North Atlantic and Europe
    ['iceland', 'scotland'], ['iceland', 'southern_norway'], ['svalbard', 'northern_norway'], ['svalbard', 'murmansk'],
    ['ireland', 'scotland'], ['ireland', 'northern_england'], ['ireland', 'southern_england'],
    ['southern_england', 'northwest_france'], ['southern_england', 'benelux'], ['northern_england', 'southern_norway'], ['scotland', 'southern_norway'],
    ['southern_norway', 'denmark'], ['svealand', 'denmark'], ['svealand', 'southern_finland'], ['svealand', 'estonia'], ['svealand', 'latvia'],
    ['southern_finland', 'estonia'], ['northern_germany', 'svealand'],
    ['sardinia', 'southeast_france'], ['sardinia', 'central_italy'], ['sicily', 'southern_italy'], ['sicily', 'tunisia'],
    ['southern_italy', 'albania_macedonia'], ['andalusia', 'northern_morocco'], ['catalonia', 'sardinia'],
    ['cyprus', 'central_anatolia'], ['cyprus', 'syria'], ['cyprus', 'holy_land'],
    ['southern_ukraine', 'western_turkey'], ['kuban', 'central_anatolia'],
    // Caspian
    ['azerbaijan', 'turkmenistan'], ['west_kazakhstan', 'azerbaijan'],
    // Americas
    ['florida', 'cuba'], ['yucatan', 'cuba'], ['cuba', 'hispaniola'], ['cuba', 'jamaica'], ['jamaica', 'hispaniola'],
    ['hispaniola', 'puerto_rico'], ['puerto_rico', 'trinidad'], ['trinidad', 'caracas'], ['jamaica', 'nicaragua'],
    ['falklands', 'south_patagonia'], ['falklands', 'magallanes'],
    // Atlantic crossings
    ['sertao', 'senegal'],
    // Africa and the Indian Ocean
    ['northern_madagascar', 'northern_mozambique'], ['southern_madagascar', 'sofala'], ['southern_madagascar', 'maputo'],
    ['northern_madagascar', 'southern_tanzania'],
    ['asir', 'eritrea'], ['sanaa', 'somaliland'], ['hadramawt', 'puntland'], ['hejaz', 'upper_egypt'],
    ['eastern_arabia', 'fars'], ['emirates', 'fars'], ['oman', 'baluchestan'], ['oman', 'sindh'],
    ['sri_lanka', 'tamil_nadu'], ['sri_lanka', 'andhra'],
    // East Asia and the Pacific
    ['hokkaido', 'sakhalin'], ['hokkaido', 'tohoku'], ['kyushu', 'kansai'], ['kyushu', 'south_korea'], ['kansai', 'south_korea'],
    ['primorye', 'hokkaido'], ['kamchatka', 'hokkaido'],
    ['taiwan', 'fujian'], ['taiwan', 'luzon'], ['hainan', 'tonkin'],
    ['shandong', 'manchuria'], ['shandong', 'south_korea'], ['jiangsu', 'south_korea'], ['jiangsu', 'kyushu'], ['visayas', 'mindanao'], ['luzon', 'guangdong'],
    ['mindanao', 'sabah_sarawak'], ['mindanao', 'sulawesi'], ['mindanao', 'maluku'],
    ['aceh', 'malaya'], ['south_sumatra', 'malaya'], ['east_java', 'nusa_tenggara'],
    ['kalimantan', 'east_java'], ['kalimantan', 'malaya'], ['sulawesi', 'maluku'], ['sulawesi', 'nusa_tenggara'],
    ['nusa_tenggara', 'kimberley'], ['papua', 'cape_york'], ['new_guinea', 'cape_york'], ['papua', 'top_end'],
    ['new_britain', 'solomon_islands'], ['solomon_islands', 'new_caledonia'],
    ['new_caledonia', 'queensland'], ['new_caledonia', 'fiji'], ['new_caledonia', 'north_island'], ['fiji', 'north_island'],
    ['south_island', 'tasmania'], ['north_island', 'new_south_wales'],
    ['tasmania', 'victoria'],
  ],
  wrapEdges: [['north_alaska', 'chukotka'], ['hawaii', 'fiji']],
};
