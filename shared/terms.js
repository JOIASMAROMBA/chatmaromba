/**
 * Regras de uso do CHATMAROMBA.
 *
 * Ficam aqui, em um lugar só, porque três partes precisam da mesma versão:
 * a tela de entrada, o comando /regras dentro do chat e a checagem do
 * servidor. Se o texto mudar, mude também a VERSAO — quem já aceitou vai
 * ver a tela de novo, que é o comportamento certo quando as regras mudam.
 *
 * Escrito em português direto, não em juridiquês: regra que ninguém lê não
 * protege ninguém.
 */

const VERSAO = '2026-09-09';

const INTRO = 'O CHATMAROMBA existe para juntar quem gosta de treino, dieta e '
  + 'vida de academia, de um jeito descontraído e divertido. É isso, e só isso.';

const SECOES = [
  {
    id: 'proibido-grave',
    icone: '🚫',
    titulo: 'Proibido, sem segunda chance',
    tom: 'grave',
    itens: [
      {
        titulo: 'Qualquer coisa envolvendo menores de idade',
        texto: 'Foto, vídeo, insinuação, paquera, pedido de contato ou aliciamento envolvendo '
          + 'menor de 18 anos. Aqui não existe advertência nem banimento temporário: a conta é '
          + 'derrubada na hora e o caso é levado às autoridades. Tolerância zero, sem exceção.'
      },
      {
        titulo: 'Conteúdo sexual ou pornográfico',
        texto: 'Nudez, ato sexual e material erótico estão proibidos na foto de perfil, nas '
          + 'mensagens e em links. A sala de Paquera é para puxar assunto, não para isso.'
      },
      {
        titulo: 'Venda de anabolizantes, hormônios e drogas ilícitas',
        texto: 'Conversar sobre o assunto é uma coisa. Vender, anunciar, indicar fornecedor, '
          + 'passar contato de vendedor ou combinar entrega é outra — e está proibido, dentro e '
          + 'fora do chat.'
      }
    ]
  },
  {
    id: 'proibido-comercial',
    icone: '📢',
    titulo: 'Nada de usar o chat para faturar',
    itens: [
      {
        titulo: 'Divulgação em massa',
        texto: 'Spam de produto, serviço, loja, link de afiliado, cupom ou "chama no direct". '
          + 'Repetir a mesma oferta em várias salas é o caso mais claro.'
      },
      {
        titulo: 'Uso profissional com fim financeiro',
        texto: 'Usar o chat como canal de captação de clientes — consultoria, personal, venda de '
          + 'planilha, coach — não é permitido. Se você está aqui para trabalhar, este não é o lugar.'
      }
    ]
  },
  {
    id: 'proibido-convivio',
    icone: '⚠️',
    titulo: 'Também é proibido',
    itens: [
      { titulo: 'Ameaça, perseguição e discurso de ódio',
        texto: 'Inclui ataque por raça, religião, origem, gênero, orientação sexual ou deficiência. '
          + 'Treta é permitida; crime não.' },
      { titulo: 'Expor dados de outra pessoa',
        texto: 'Nome completo, endereço, telefone, local de trabalho ou print de conversa privada, '
          + 'sem autorização.' },
      { titulo: 'Se passar por outra pessoa',
        texto: 'Usar nome, foto ou identidade de alguém real para enganar.' },
      { titulo: 'Robô, script ou automação',
        texto: 'Qualquer programa que mande mensagem, abra conexões ou colete dados no lugar de uma pessoa.' }
    ]
  },
  {
    id: 'nao-somos',
    icone: '🤝',
    titulo: 'O que nós NÃO somos',
    itens: [
      {
        titulo: 'Não intermediamos negociação nenhuma',
        texto: 'Qualquer combinação, compra, venda, troca, encontro ou acordo entre usuários é por '
          + 'conta e risco de vocês. Não participamos, não garantimos, não conferimos e não '
          + 'respondemos por nada disso — nem por prejuízo, calote ou golpe.'
      },
      {
        titulo: 'Não respondemos por contato fora daqui',
        texto: 'Se você passar WhatsApp, Instagram, telefone ou endereço para alguém, o que '
          + 'acontecer a partir dali está fora do nosso alcance. Pense duas vezes antes de entregar '
          + 'seu contato para um desconhecido.'
      },
      {
        titulo: 'Não é orientação médica',
        texto: 'Tudo que se fala aqui sobre treino, dieta, suplemento, substância ou exame é '
          + 'opinião de gente anônima na internet. Não é receita, não é prescrição e não substitui '
          + 'médico, nutricionista ou educador físico.'
      }
    ]
  },
  {
    id: 'como-funciona',
    icone: '🛡️',
    titulo: 'Como a moderação funciona',
    itens: [
      { titulo: 'Filtro automático e moderadores',
        texto: 'A punição vai de silenciar por alguns minutos até banimento, conforme a gravidade.' },
      { titulo: 'Denuncie',
        texto: 'Toque no 🚩 ao lado da mensagem. A denúncia chega na hora para quem estiver de plantão.' },
      { titulo: 'Nada fica guardado',
        texto: 'As conversas e as fotos ficam só na memória e somem quando o servidor reinicia. '
          + 'Não pedimos e-mail, não criamos cadastro e não vendemos dado de ninguém.' }
    ]
  }
];

const IDADE = 'Ao entrar, você declara ter 18 anos ou mais e concorda com tudo acima.';

/** Versão em texto puro, para o comando /regras dentro do chat */
function emTexto() {
  const linhas = ['REGRAS DO CHATMAROMBA (' + VERSAO + ')', '', INTRO, ''];
  for (const secao of SECOES) {
    linhas.push(secao.icone + ' ' + secao.titulo.toUpperCase());
    for (const item of secao.itens) linhas.push('  • ' + item.titulo + ': ' + item.texto);
    linhas.push('');
  }
  linhas.push(IDADE);
  return linhas.join('\n');
}

module.exports = { VERSAO, INTRO, SECOES, IDADE, emTexto };
