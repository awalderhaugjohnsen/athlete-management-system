export const report = {
  header: {
    title: "Fremgang",
    subtitle: "Ukentlige gjennomganger, langsiktige trender og sesonganalyse",
    syncHistoryHint: "Kjør {cmd} for å laste inn full Garmin-historikk",
  },
  tabs: {
    thisWeek: "Denne uken",
    trends: "Trender",
    seasonAnalysis: "Sesonganalyse",
    exercises: "Øvelser",
  },
  exercises: {
    strengthTitle: "Styrkeøvelser",
    runningTitle: "Løpeøktstyper",
    noExercises: "Ingen fullførte styrkesett ennå.",
    noSessionTypes: "Ingen fullførte løpeturer matchet til en planlagt økttype ennå.",
    onlyOneSession: "Bare én registrert økt så langt ({value}) — sjekk tilbake etter neste økt.",
  },
  week: {
    weekOf: "Uke fra {date}",
    emptyTitle: "Ingen ukentlig gjennomgang ennå",
    emptyBody: "Genereres automatisk ved hver ukentlige innsjekk.",
    vsLastWeek: "vs. forrige uke",
    kpiDelta: {
      hrv: "HRV",
      rhr: "Hvilepuls",
      sleepHours: "Søvn",
    },
  },
  trends: {
    hint: "Fargede prikker viser sonestatus · klikk på en graf for å utvide",
    emptyTitle: "Ikke nok historikk ennå",
    emptyBody: "Kjør {cmd} for å hente inn historikk fra Garmin.",
    notEnoughData: "Ikke nok data",
    daysCount: "{count} dager",
    hoverToInspect: "Hold pekeren over for detaljer",
    hoverToInspectInline: "hold pekeren over for detaljer",
    anomaliesFlagged: "{count} avvik markert",
    anomalyLabel: "avvik",
    perWeek: "/ 7d",
    close: "Lukk",
    status: {
      onTarget: "På mål",
      optimal: "Optimal",
      caution: "Advarsel",
      risk: "Risiko",
    },
    pmcStatus: {
      raceReady: "konkurranseklar",
      caution: "advarsel",
      risk: "risiko",
    },
    units: {
      load: "belastning",
      hours: "t",
      ctlPerWeek: "CTL/uke",
    },
    series: {
      acwr: {
        label: "Treningsbelastningsforhold (ACWR)",
        zones: {
          underTraining: { label: "Undertrening (<0.8)", chart: "Undertrening" },
          optimal: { label: "Optimal sone (0.8–1.3)", chart: "Optimal sone" },
          risk: { label: "Risikosone (>1.3)", chart: "Risikosone" },
        },
      },
      ctl: { label: "Kondisjon (CTL)" },
      tsb: {
        label: "Form (TSB)",
        zones: {
          overreaching: { label: "Overtrening (<-30)", chart: "Overtrening" },
          trainingLoad: { label: "Treningsbelastning (-30–-10)", chart: "Treningsbelastning" },
          raceReady: { label: "Konkurranseklar (-10 til +5)", chart: "Konkurranseklar" },
          fresh: { label: "Uthvilt (+5 til +25)", chart: "Uthvilt" },
          overtapered: { label: "Overtapret (>+25)", chart: "Overtapret" },
        },
      },
      atl: { label: "Utmattelse (ATL)" },
      recovery: {
        label: "Restitusjonsscore",
        zones: {
          required: { label: "Restitusjon nødvendig (<40)", chart: "Restitusjon nødvendig" },
          caution: { label: "Advarselssone (40–65)", chart: "Advarsel" },
          optimal: { label: "Optimal restitusjon (>65)", chart: "Optimal restitusjon" },
        },
      },
      vo2max: { label: "VO₂maks" },
      hrv: {
        label: "HRV (natt)",
        shortLabel: "HRV",
        zones: {
          suppressed: { label: "Undertrykt (>2 SD under)", chart: "Undertrykt" },
          low: { label: "Lav (1–2 SD under)", chart: "Lav" },
          baseline: { labelTemplate: "Grunnlinje ±1 SD ({value} ms)", chart: "Grunnlinje" },
          elevated: { label: "Forhøyet (>1 SD over)", chart: "Forhøyet" },
        },
        lines: {
          baselineTemplate: "Grunnlinje {value} ms",
        },
      },
      sleepScore: {
        label: "Søvnscore",
        zones: {
          poor: { label: "Dårlig (<50)", chart: "Dårlig" },
          fair: { label: "Middels (50–70)", chart: "Middels" },
          good: { label: "Bra (>70)", chart: "Bra" },
        },
      },
      sleepHours: {
        label: "Søvntimer",
        zones: {
          tooLittle: { label: "For lite (<6 t)", chart: "For lite" },
          marginal: { label: "Marginalt (6–7 t)", chart: "Marginalt" },
          optimal: { label: "Optimalt (7–9 t)", chart: "Optimalt" },
          long: { label: "Langt (>9 t)", chart: "Langt" },
        },
      },
      rhr: {
        label: "Hvilepuls",
        zones: {
          excellent: { label: "Utmerket (<50)", chart: "Utmerket" },
          good: { label: "Bra (50–60)", chart: "Bra" },
          moderate: { label: "Moderat (60–70)", chart: "Moderat" },
          elevated: { label: "Forhøyet (>70)", chart: "Forhøyet" },
        },
      },
      bodyBattery: {
        label: "Body Battery (kveld)",
        zones: {
          depleted: { label: "Utladet (<25)", chart: "Utladet" },
          low: { label: "Lavt (25–50)", chart: "Lavt" },
          good: { label: "Bra (>50)", chart: "Bra" },
        },
      },
      stress: {
        label: "Daglig stress",
        zones: {
          low: { label: "Lavt (<25)", chart: "Lavt" },
          moderate: { label: "Moderat (25–50)", chart: "Moderat" },
          high: { label: "Høyt (>50)", chart: "Høyt stress" },
        },
      },
      rampRate: {
        label: "Belastningstilpasning",
        zones: {
          detraining: { label: "Avtrening (<-5)", chart: "Avtrening" },
          recovery: { label: "Restitusjon (-5–0)", chart: "Restitusjon" },
          optimalBuild: { label: "Optimal oppbygging (0–7)", chart: "Optimal oppbygging" },
          caution: { label: "Advarsel (7–12)", chart: "Advarsel" },
          injuryRisk: { label: "Skaderisiko (>12)", chart: "Skaderisiko" },
        },
        lines: {
          caution: "advarsel",
          injuryRisk: "skaderisiko",
        },
      },
      weight: { label: "Kroppsvekt" },
      calories: { label: "Kalorier forbrent" },
      benchE1rm: { label: "Benkpress e1RM (Epley)" },
      pred5k: { label: "Predikert 5 km" },
      pred10k: { label: "Predikert 10 km" },
      predHalfMarathon: { label: "Predikert halvmaraton" },
      predMarathon: { label: "Predikert maraton" },
    },
  },
  pmc: {
    title: "Prestasjonsstyring",
    legendDefinitions: "CTL = kronisk treningsbelastning · ATL = akutt utmattelse · TSB = form (CTL − ATL)",
    fitnessAndFatigue: "Kondisjon og utmattelse",
  },
  analysis: {
    generatedOn: "Generert {date}",
    analysisTab: "Analyse",
    planningTab: "Treningsplan",
  },
};
