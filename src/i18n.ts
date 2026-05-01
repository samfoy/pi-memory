type Locale = "en" | "es" | "fr" | "pt-BR";
type Params = Record<string, string | number>;

const translations: Record<Exclude<Locale, "en">, Record<string, string>> = {
  es: {
    "memory.common.storeNotInitialized": "El almacén de memoria no está inicializado",
    "memory.forget.invalidType": "Tipo no válido: {type}. Debe ser 'fact' o 'lesson'.",
    "memory.forget.factDeleted": "Olvidado: {key}",
    "memory.forget.factNotFound": "No encontrado: {key}",
    "memory.forget.lessonDeleted": "Lección olvidada {id}",
    "memory.forget.lessonNotFound": "No encontrada: {id}",
    "memory.forget.missingTarget": "Indica key (para hechos) o id (para lecciones)",
  },
  fr: {
    "memory.common.storeNotInitialized": "Le magasin mémoire n’est pas initialisé",
    "memory.forget.invalidType": "Type non valide : {type}. Doit être 'fact' ou 'lesson'.",
    "memory.forget.factDeleted": "Oublié : {key}",
    "memory.forget.factNotFound": "Introuvable : {key}",
    "memory.forget.lessonDeleted": "Leçon oubliée {id}",
    "memory.forget.lessonNotFound": "Introuvable : {id}",
    "memory.forget.missingTarget": "Fournissez key (pour les faits) ou id (pour les leçons)",
  },
  "pt-BR": {
    "memory.common.storeNotInitialized": "O armazenamento de memória não foi inicializado",
    "memory.forget.invalidType": "Tipo inválido: {type}. Deve ser 'fact' ou 'lesson'.",
    "memory.forget.factDeleted": "Esquecido: {key}",
    "memory.forget.factNotFound": "Não encontrado: {key}",
    "memory.forget.lessonDeleted": "Lição esquecida {id}",
    "memory.forget.lessonNotFound": "Não encontrada: {id}",
    "memory.forget.missingTarget": "Informe key (para fatos) ou id (para lições)",
  },
};

let currentLocale: Locale = "en";

export function initI18n(pi: { events?: { emit?: (event: string, payload: unknown) => void } }): void {
  pi.events?.emit?.("pi-core/i18n/registerBundle", {
    namespace: "pi-memory",
    defaultLocale: "en",
    locales: translations,
  });
  pi.events?.emit?.("pi-core/i18n/requestApi", {
    onReady: (api: { getLocale?: () => string; onLocaleChange?: (cb: (locale: string) => void) => void }) => {
      const locale = api.getLocale?.();
      if (isLocale(locale)) currentLocale = locale;
      api.onLocaleChange?.((next) => {
        if (isLocale(next)) currentLocale = next;
      });
    },
  });
}

export function t(key: string, fallback: string, params: Params = {}): string {
  const template = currentLocale === "en" ? fallback : translations[currentLocale]?.[key] ?? fallback;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
}

function isLocale(locale: string | undefined): locale is Locale {
  return locale === "en" || locale === "es" || locale === "fr" || locale === "pt-BR";
}
