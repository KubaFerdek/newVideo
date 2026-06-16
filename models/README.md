# @site-generator/models

AI Browser Automation Models - moduł odpowiedzialny za komunikację z AI (ChatGPT, Gemini) przez automatyzację przeglądarki.

## 📦 Zawartość

### AI Browser Wrappers

- **chatgpt-browser.ts** - Wrapper dla ChatGPT z automatyzacją przeglądarki
- **gemini-browser.ts** - Wrapper dla Gemini z automatyzacją przeglądarki

### Login Scripts

- **chatgpt-login.ts** - Ręczny login do ChatGPT (zapisuje sesję)
- **gemini-login.ts** - Ręczny login do Gemini (zapisuje sesję)

### Browser Profiles

- **browser-profiles/** - Profile przeglądarek z zapisanymi sesjami
  - `chatgpt/` - Profil dla ChatGPT
  - `gemini/` - Profil dla Gemini

### Configuration

- **config/paths.ts** - Zarządzanie ścieżkami do profili przeglądarek

## 🚀 Użycie

### Logowanie (pierwsze uruchomienie)

```bash
# Z głównego katalogu workspace
pnpm chatgpt:login
pnpm gemini:login

# Lub z katalogu models
pnpm chatgpt:login
pnpm gemini:login
```

### Import w innych modułach

```typescript
// Import ChatGPT wrapper
import { askChatGptInBrowser } from "../../../models/chatgpt-browser.js";

// Użycie
const response = await askChatGptInBrowser("Your prompt here", {
  headless: false,
  timeout: 900000,
  maxRetries: 3,
});
```

## 📁 Browser Profiles

Profile przeglądarek przechowują dane sesji (cookies, localStorage, etc.) co pozwala na:

- ✅ Brak konieczności logowania przy każdym uruchomieniu
- ✅ Zachowanie preferencji użytkownika
- ✅ Szybsze wykonanie (brak opóźnień logowania)

⚠️ **Uwaga**: Profile są ignorowane przez .gitignore i nie powinny być commitowane!

## 🔧 Zależności

- `playwright` - automatyzacja przeglądarki
- `@types/node`, `tsx`, `typescript` - dev dependencies

## 🔗 Reużywalność

Ten moduł może być używany przez:

- `@site-generator/content-generator`
- `@site-generator/materials`
- Inne projekty wymagające automatyzacji AI

## 📝 Eksporty

```json
{
  "exports": {
    "./chatgpt": "./chatgpt-browser.ts",
    "./gemini": "./gemini-browser.ts"
  }
}
```
