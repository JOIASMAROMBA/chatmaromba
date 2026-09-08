/**
 * Catálogo de salas do CHATMAROMBA.
 * Usado pelo servidor e enviado ao cliente via GET /api/rooms.
 */

const THEMES = [
  { id: 'geral',         name: 'Geral',            icon: '🏠', color: '#7c5cff', tagline: 'Papo livre da marombada' },
  { id: 'emagrecimento', name: 'Emagrecimento',    icon: '🔥', color: '#ff5f6d', tagline: 'Cutting, déficit e cardio' },
  { id: 'ganho',         name: 'Ganho de Peso',    icon: '💪', color: '#00d4ff', tagline: 'Bulking, hipertrofia e força' },
  { id: 'venenos',       name: 'Venenos',          icon: '💊', color: '#c026d3', tagline: 'Papo de ciclo, TPC e afins' },
  { id: 'treta',         name: 'Treta',            icon: '⚔️', color: '#ff9f1c', tagline: 'Barraco liberado, sem chorar' },
  { id: 'paquera',       name: 'Paquera',          icon: '💘', color: '#ff4d94', tagline: 'A sala do date pós-treino' },
  { id: 'dieta',         name: 'Dieta & Receitas', icon: '🍗', color: '#22c55e', tagline: 'Macros, marmita e receita fit' },
  { id: 'treino',        name: 'Treino & Fichas',  icon: '🏋️', color: '#38bdf8', tagline: 'ABC, PPL, full body' },
  { id: 'suplementos',   name: 'Suplementos',      icon: '🥤', color: '#facc15', tagline: 'Whey, creatina e pré-treino' },
  { id: 'natural',       name: 'Natural',          icon: '🌱', color: '#4ade80', tagline: 'Só comida e treino, sem nada' },
  { id: 'competicao',    name: 'Competição',       icon: '🏆', color: '#f97316', tagline: 'Palco, peak week e posing' },
  { id: 'lesao',         name: 'Lesões & Saúde',   icon: '🩺', color: '#60a5fa', tagline: 'Dor, exame e recuperação' },
  { id: 'motivacao',     name: 'Motivação',        icon: '🧠', color: '#a78bfa', tagline: 'Foco, disciplina e mente' },
  { id: 'zoeira',        name: 'Zoeira',           icon: '😂', color: '#fbbf24', tagline: 'Meme, print e resenha' }
];

const STATES = [
  { uf: 'AC', name: 'Acre',                cities: ['Rio Branco', 'Cruzeiro do Sul', 'Sena Madureira', 'Tarauacá'] },
  { uf: 'AL', name: 'Alagoas',             cities: ['Maceió', 'Arapiraca', 'Palmeira dos Índios', 'Rio Largo'] },
  { uf: 'AP', name: 'Amapá',               cities: ['Macapá', 'Santana', 'Laranjal do Jari', 'Oiapoque'] },
  { uf: 'AM', name: 'Amazonas',            cities: ['Manaus', 'Parintins', 'Itacoatiara', 'Manacapuru'] },
  { uf: 'BA', name: 'Bahia',               cities: ['Salvador', 'Feira de Santana', 'Vitória da Conquista', 'Camaçari', 'Ilhéus', 'Juazeiro'] },
  { uf: 'CE', name: 'Ceará',               cities: ['Fortaleza', 'Caucaia', 'Juazeiro do Norte', 'Sobral', 'Maracanaú'] },
  { uf: 'DF', name: 'Distrito Federal',    cities: ['Brasília', 'Taguatinga', 'Ceilândia', 'Águas Claras', 'Gama'] },
  { uf: 'ES', name: 'Espírito Santo',      cities: ['Vitória', 'Vila Velha', 'Serra', 'Cariacica', 'Linhares'] },
  { uf: 'GO', name: 'Goiás',               cities: ['Goiânia', 'Aparecida de Goiânia', 'Anápolis', 'Rio Verde', 'Luziânia'] },
  { uf: 'MA', name: 'Maranhão',            cities: ['São Luís', 'Imperatriz', 'Timon', 'Caxias', 'Codó'] },
  { uf: 'MT', name: 'Mato Grosso',         cities: ['Cuiabá', 'Várzea Grande', 'Rondonópolis', 'Sinop', 'Sorriso'] },
  { uf: 'MS', name: 'Mato Grosso do Sul',  cities: ['Campo Grande', 'Dourados', 'Três Lagoas', 'Corumbá'] },
  { uf: 'MG', name: 'Minas Gerais',        cities: ['Belo Horizonte', 'Uberlândia', 'Contagem', 'Juiz de Fora', 'Betim', 'Montes Claros', 'Uberaba'] },
  { uf: 'PA', name: 'Pará',                cities: ['Belém', 'Ananindeua', 'Santarém', 'Marabá', 'Castanhal'] },
  { uf: 'PB', name: 'Paraíba',             cities: ['João Pessoa', 'Campina Grande', 'Santa Rita', 'Patos'] },
  { uf: 'PR', name: 'Paraná',              cities: ['Curitiba', 'Londrina', 'Maringá', 'Ponta Grossa', 'Cascavel', 'Foz do Iguaçu'] },
  { uf: 'PE', name: 'Pernambuco',          cities: ['Recife', 'Jaboatão dos Guararapes', 'Olinda', 'Caruaru', 'Petrolina'] },
  { uf: 'PI', name: 'Piauí',               cities: ['Teresina', 'Parnaíba', 'Picos', 'Floriano'] },
  { uf: 'RJ', name: 'Rio de Janeiro',      cities: ['Rio de Janeiro', 'São Gonçalo', 'Duque de Caxias', 'Niterói', 'Nova Iguaçu', 'Campos dos Goytacazes', 'Petrópolis'] },
  { uf: 'RN', name: 'Rio Grande do Norte', cities: ['Natal', 'Mossoró', 'Parnamirim', 'São Gonçalo do Amarante'] },
  { uf: 'RS', name: 'Rio Grande do Sul',   cities: ['Porto Alegre', 'Caxias do Sul', 'Pelotas', 'Canoas', 'Santa Maria', 'Gravataí'] },
  { uf: 'RO', name: 'Rondônia',            cities: ['Porto Velho', 'Ji-Paraná', 'Ariquemes', 'Vilhena'] },
  { uf: 'RR', name: 'Roraima',             cities: ['Boa Vista', 'Rorainópolis', 'Caracaraí'] },
  { uf: 'SC', name: 'Santa Catarina',      cities: ['Florianópolis', 'Joinville', 'Blumenau', 'São José', 'Chapecó', 'Criciúma'] },
  { uf: 'SP', name: 'São Paulo',           cities: ['São Paulo', 'Guarulhos', 'Campinas', 'São Bernardo do Campo', 'Santo André', 'Osasco', 'Ribeirão Preto', 'Sorocaba', 'Santos', 'São José dos Campos'] },
  { uf: 'SE', name: 'Sergipe',             cities: ['Aracaju', 'Nossa Senhora do Socorro', 'Lagarto', 'Itabaiana'] },
  { uf: 'TO', name: 'Tocantins',           cities: ['Palmas', 'Araguaína', 'Gurupi', 'Porto Nacional'] }
];

/** slug estável, sem acento, para compor ids de sala */
function slug(text) {
  return String(text)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Lista completa de salas válidas: temas + estados + cidades */
function buildRooms() {
  const rooms = new Map();

  for (const t of THEMES) {
    rooms.set('tema:' + t.id, {
      id: 'tema:' + t.id,
      kind: 'tema',
      name: t.name,
      icon: t.icon,
      color: t.color,
      tagline: t.tagline
    });
  }

  for (const s of STATES) {
    rooms.set('uf:' + s.uf, {
      id: 'uf:' + s.uf,
      kind: 'estado',
      name: s.name + ' — Geral',
      icon: '📍',
      color: '#7c5cff',
      tagline: 'Sala geral do estado (' + s.uf + ')'
    });

    for (const c of s.cities) {
      rooms.set('cidade:' + s.uf + ':' + slug(c), {
        id: 'cidade:' + s.uf + ':' + slug(c),
        kind: 'cidade',
        name: c + ' / ' + s.uf,
        icon: '🏙️',
        color: '#00d4ff',
        tagline: 'Marombeiros de ' + c
      });
    }
  }

  return rooms;
}

module.exports = { THEMES, STATES, slug, buildRooms };
