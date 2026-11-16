/*
 * Phrase catalog of the Fechamento do trimestre: wording only, no logic. Every message has
 * same-meaning variants, so the lists are structurally alike by design; this file is excluded from
 * copy-paste detection in .sonarcloud.properties. Approved by the school (D6); wording changes need
 * a new approval.
 */
export const TERM_CLOSING_CATALOG_V1 = {
  'conclusion.good-with-point': [
    'Seu trimestre foi bom, mas há um ponto para cuidar.',
    'Você foi bem neste trimestre, e ainda dá para ajustar um detalhe.',
    'Bom trimestre! Só um ponto merece sua atenção.',
  ],
  'conclusion.attention': [
    'Esta disciplina pede sua atenção.',
    'Neste trimestre, esta disciplina precisa de mais cuidado.',
    'Vale dar uma atenção especial a esta disciplina.',
  ],
  'conclusion.recovery': [
    'Nesta disciplina, o próximo passo é a recuperação.',
    'Você vai fazer a recuperação nesta disciplina.',
    'Esta disciplina segue para a recuperação.',
  ],
  'weight.assessments': [
    'As avaliações foram o principal ponto de preocupação.',
    'O que mais pesou neste trimestre foram as avaliações.',
    'As avaliações foram a parte mais difícil deste trimestre.',
  ],
  'weight.not-done': [
    'Algumas atividades ficaram sem ser feitas, e isso pesou.',
    'Houve atividades não realizadas neste trimestre, e elas fizeram falta.',
    'Atividades que ficaram para trás pesaram no seu resultado.',
  ],
  // Exactly one activity not done (no plural for a single one).
  'weight.not-done-one': [
    'Uma atividade ficou sem ser feita, e isso pesou.',
    'Houve uma atividade não realizada neste trimestre, e ela fez falta.',
    'Uma atividade que ficou para trás pesou no seu resultado.',
  ],
  'weight.activities': [
    'As atividades do dia a dia foram um desafio para você.',
    'As atividades ao longo do trimestre foram o principal ponto de atenção.',
    'O que mais pesou foram as atividades do dia a dia.',
  ],
  'strength.activities': [
    'Suas atividades ao longo do trimestre ajudaram seu resultado.',
    'Você foi bem nas atividades do dia a dia.',
    'As atividades do trimestre foram um ponto forte seu.',
  ],
  'strength.assessments': [
    'Você foi bem nas avaliações.',
    'As avaliações foram um ponto forte seu neste trimestre.',
    'Seu desempenho nas avaliações ajudou bastante.',
  ],
  'strength.all-done': [
    'Você fez todas as atividades do trimestre.',
    'Nenhuma atividade ficou para trás, e isso conta muito.',
    'Você manteve todas as atividades em dia.',
  ],
  'strength.parallel-done': [
    'Você fez a prova paralela e aproveitou a chance de recuperar.',
    'Você também fez a prova paralela deste trimestre.',
    'Você não deixou passar a prova paralela.',
  ],
  'action.catch-up': [
    'Agora: procure fazer todas as próximas atividades.',
    'Agora: não deixe nenhuma atividade para trás no próximo trimestre.',
    'Agora: mantenha todas as atividades em dia daqui para frente.',
  ],
  'action.assessments': [
    'Agora: prepare-se com antecedência para as próximas avaliações.',
    'Agora: dedique um tempo extra às próximas avaliações.',
    'Agora: foque nas próximas avaliações desta disciplina.',
  ],
  'action.keep': [
    'Agora: continue nesse ritmo.',
    'Agora: mantenha o que está dando certo.',
    'Agora: siga do mesmo jeito no próximo trimestre.',
  ],
  'action.recovery': [
    'Agora: prepare-se para a recuperação desta disciplina.',
    'Agora: use este tempo para se preparar para a recuperação.',
    'Agora: foque na recuperação. É a sua chance nesta disciplina.',
  ],
  'line.good': [
    'Você fechou bem este trimestre.',
    'Bom trimestre nesta disciplina. Continue assim.',
    'Tudo em ordem neste trimestre.',
    'Você foi bem neste trimestre.',
    'Belo trimestre nesta disciplina.',
    'Trimestre bem fechado. Siga assim.',
  ],
  'line.year-good': [
    'Você fechou bem o último trimestre desta disciplina.',
    'Bom fechamento de ano nesta disciplina.',
    'Você terminou bem o ano nesta disciplina.',
  ],
  'summary.all-good': [
    'Você fechou bem o {trimestre} em todas as disciplinas.',
    'Todas as suas disciplinas fecharam bem no {trimestre}.',
    'Ótimo {trimestre}: todas as disciplinas fecharam bem.',
  ],
  // `{pede}`/`{merece}` resolve singular/plural from the list size (never a number).
  'summary.few-attention': [
    'Você fechou bem o {trimestre} na maior parte das disciplinas. {lista} {pede} sua atenção.',
    'Bom {trimestre} na maioria das disciplinas. Vale cuidar de {lista}.',
    'A maior parte das suas disciplinas fechou bem no {trimestre}. {lista} {merece} mais atenção.',
  ],
  'summary.many-attention': [
    'Algumas disciplinas pedem sua atenção neste {trimestre}: {lista}.',
    'Neste {trimestre}, vale dar atenção especial a {lista}.',
    'Depois deste {trimestre}, vale cuidar melhor de {lista}.',
  ],
  /*
   * Acompanhamento (policy `termClosingConclusive` off): the trimester in progress, present tense,
   * no conclusions. Only facts recorded so far are read; still never a number (R1).
   */
  'progress.conclusion.point': [
    'Você está indo bem, mas há um ponto para cuidar.',
    'Até aqui, bom andamento, com um ponto que merece atenção.',
    'O trimestre vai bem, e ainda dá para ajustar um detalhe.',
  ],
  'progress.conclusion.attention': [
    'Até agora, esta disciplina pede sua atenção.',
    'Neste momento, esta disciplina precisa de mais cuidado.',
    'Por enquanto, vale dar uma atenção especial a esta disciplina.',
  ],
  'progress.weight.assessments': [
    'Até agora, as avaliações são o principal ponto de atenção.',
    'O que mais pesa até aqui são as avaliações.',
    'As avaliações estão sendo a parte mais difícil até agora.',
  ],
  'progress.weight.not-done': [
    'Há atividades não realizadas neste trimestre.',
    'Algumas atividades ficaram sem ser feitas até agora.',
    'Atividades não realizadas estão pesando no seu andamento.',
  ],
  'progress.weight.not-done-one': [
    'Há uma atividade não realizada neste trimestre.',
    'Uma atividade ficou sem ser feita até agora.',
    'Uma atividade não realizada está pesando no seu andamento.',
  ],
  'progress.weight.activities': [
    'As atividades do dia a dia estão sendo um desafio para você.',
    'Até agora, as atividades do dia a dia são o principal ponto de atenção.',
    'O que mais pesa até aqui são as atividades do dia a dia.',
  ],
  'progress.strength.activities': [
    'Suas atividades estão ajudando no seu andamento.',
    'Você está indo bem nas atividades do dia a dia.',
    'As atividades estão sendo um ponto forte seu.',
  ],
  'progress.strength.assessments': [
    'Você está indo bem nas avaliações.',
    'As avaliações estão sendo um ponto forte seu.',
    'Seu desempenho nas avaliações está ajudando bastante.',
  ],
  'progress.strength.all-done': [
    'Você está fazendo todas as atividades.',
    'Nenhuma atividade ficou para trás até agora.',
    'Você está com as atividades em dia.',
  ],
  'progress.strength.parallel-done': [
    'Você fez a prova paralela e aproveitou a chance de recuperar.',
    'Você também fez a prova paralela deste trimestre.',
    'A prova paralela deste trimestre já está feita.',
  ],
  'progress.action.catch-up': [
    'Agora: procure fazer todas as próximas atividades.',
    'Agora: não deixe as próximas atividades para trás.',
    'Agora: mantenha as próximas atividades em dia.',
  ],
  'progress.action.assessments': [
    'Agora: prepare-se com antecedência para as próximas avaliações.',
    'Agora: dedique um tempo extra às próximas avaliações.',
    'Agora: foque nas próximas avaliações desta disciplina.',
  ],
  'progress.line.good': [
    'Até aqui, tudo certo nesta disciplina.',
    'Você está indo bem nesta disciplina.',
    'Bom andamento neste trimestre. Continue assim.',
    'Por enquanto, tudo em ordem nesta disciplina.',
    'Você segue bem neste trimestre.',
    'Bom ritmo até aqui. Siga assim.',
  ],
  'progress.summary.all-good': [
    'Até agora, você vai bem no {trimestre} em todas as disciplinas.',
    'Neste {trimestre}, todas as suas disciplinas estão indo bem até aqui.',
    'Bom andamento no {trimestre}: todas as disciplinas vão bem.',
  ],
  'progress.summary.few-attention': [
    'Até agora, o {trimestre} vai bem na maior parte das disciplinas. {lista} {pede} sua atenção.',
    'Bom andamento no {trimestre} na maioria das disciplinas. Vale cuidar de {lista}.',
    'A maior parte das disciplinas vai bem neste {trimestre}. {lista} {merece} mais atenção agora.',
  ],
  'progress.summary.many-attention': [
    'Algumas disciplinas pedem sua atenção neste {trimestre}: {lista}.',
    'Neste {trimestre}, vale dar atenção especial a {lista} desde já.',
    'Ainda dá tempo de cuidar melhor de {lista} neste {trimestre}.',
  ],
} as const satisfies Record<string, readonly string[]>;
