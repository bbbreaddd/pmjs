function warmIntl(config) {
  if (!config) return;
  if (config.numberEn) (1234567).toLocaleString('en');
  if (config.dateEn) new Date(0).toLocaleDateString('en');
  if (config.collatorEn) 'b'.localeCompare('a', 'en');
}

warmIntl(PMJS.config.intlWarmup);
