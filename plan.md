# Projekt: Wtyczka do przeglądarki — tracker obejrzanych (Netflix, Disney+, Max, Prime Video)

**Język projektu: angielski.** Nazewnictwo w kodzie (nazwy zmiennych, funkcji, plików), komentarze i cały UI popupu — po angielsku (np. "Movie" nie "Film", "Watched" nie "Obejrzane", "Season/Episode" nie "Sezon/Odcinek"). Standard w branży, tak samo jak reszta projektów w portfolio — repo ma być czytelne dla każdego rekrutera, nie tylko polskiego.

## Problem

Historia oglądania jest rozproszona po platformach streamingowych i nietrwała (np. Netflix kasuje/przycina historię, gdy nie masz aktywnej subskrypcji). Brak jednego miejsca, gdzie widać na czym skończyłeś, niezależnie od platformy.

## Koncepcja

Wtyczka lokalnie śledzi co oglądasz na wspieranych platformach, zapisuje trwale u siebie (niezależnie od tego co robi dana platforma ze swoją historią).

---

## Zakres funkcji (MVP)

| Funkcja                | Jak działa                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Tytuł                  | Selektor DOM / `document.title`                                                                                            |
| Platforma              | Hardcode per content script (Netflix, Disney+)                                                                             |
| % obejrzane (film)     | `video.currentTime / video.duration`                                                                                       |
| Sezon/odcinek (serial) | Parsowanie `document.title` (jeśli platforma to udostępnia) → fallback: pasek tytułu w odtwarzaczu                         |
| Okładka                | Selektor na `<img>` / `background-image`                                                                                   |
| Detekcja "obejrzane"   | `MutationObserver` czekający na natywną nakładkę platformy ("Następny odcinek" / ekran napisów końcowych) — nie liczenie % |
| Trwałość historii      | `chrome.storage.local` — niezależna od tego co robi platforma ze swoją historią                                            |

**MVP = Netflix + Disney+, pełen zestaw funkcji z tabeli.** Max i Prime Video jako v2 — nie okrajaj funkcji, okrajaj liczbę platform.

---

## Wymagane oprogramowanie

| Narzędzie           | Do czego                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| **Git**             | kontrola wersji                                                                                |
| **Node.js (LTS)**   | opcjonalnie — tylko jeśli dorzucisz ESLint/Prettier albo drobną bibliotekę przez npm           |
| **Chrome DevTools** | kluczowe — ręczne namierzanie selektorów per platforma przed pisaniem kodu (zakładka Elements) |

**Nie potrzebujesz:**

- Docker — brak backendu
- Postgres — `chrome.storage.local` wystarczy
- AWS/deploy — wtyczka działa lokalnie u użytkownika
- Bundler/build step (Vite itp.) — patrz niżej

---

## Stack

- **Manifest V3** (`manifest.json`)
- Content scripts: **vanilla JS/TS**, osobny plik per platforma
- Storage: `chrome.storage.local`
- **Popup UI: czysty JS + HTML + CSS, bez React/Vite** — popup to statyczna lista + wyszukiwarka, brak złożonego stanu czy re-renderów, więc framework to zbędna narzutowa robota (build step, konfiguracja pod rozszerzenie). `popup.html` ładuje `popup.js` bezpośrednio przez `<script>`, zero kroku budowania
- Detekcja zmian DOM: `MutationObserver`
- **Ważne ustawienie manifestu:** `"world": "MAIN"` dla content scriptów — część platform izoluje `<video>` w innym kontekście JS, bez tego skrypt może nie mieć dostępu do elementu

---

## Struktura repo

```
watch-tracker/
├── manifest.json
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── content-scripts/
│   ├── netflix.js
│   └── disneyplus.js
└── storage.js   # wspólna logika zapisu/odczytu chrome.storage.local
```

---

## Kroki budowy (kolejność)

### 1. Repo na GitHubie — od razu, jak przy price trackerze

```
git init
git remote add origin https://github.com/<twoj-user>/watch-tracker.git
git add .
git commit -m "Init: struktura projektu"
git push -u origin main
```

Commituj na bieżąco po każdym etapie — historia commitów jest częścią portfolio.

### 2. Rekonesans selektorów (przed kodem!)

- Otwórz Netflix, DevTools → Elements
- Namierz: selektor tytułu, selektor okładki, sposób pokazania sezonu/odcinka, element nakładki "Następny odcinek"
- Powtórz dla Disney+
- Zapisz selektory w notatce — to podstawa pod content scripts

### 3. `manifest.json`

- Deklaracja `content_scripts` z `matches` dla domen Netflix i Disney+
- `"world": "MAIN"` tam gdzie potrzebny dostęp do `<video>`
- Uprawnienie `storage`

### 4. `storage.js` — wspólna logika

- Funkcje: zapisz wpis (tytuł, platforma, sezon/odcinek, okładka, status: w trakcie/obejrzane, % postępu)
- Funkcja: pobierz historię, funkcja: wyszukaj po tytule

### 5. Content script: Netflix

- Nasłuch `<video>`: `timeupdate` → licz %
- `MutationObserver` na nakładkę końca odcinka/filmu → oznacz jako obejrzane
- Parsowanie tytułu/sezonu/odcinka z DOM
- Wywołanie funkcji zapisu ze `storage.js`

### 6. Content script: Disney+

- Analogicznie do Netflixa, ale z własnymi selektorami (inny DOM)

### 7. Popup

- Lista zapisanych pozycji: tytuł, okładka, platforma, status/postęp
- Wyszukiwarka po tytule
- Test: "Load unpacked" w `chrome://extensions`

### 8. README

- Opis, GIF z działania (oglądasz odcinek → wtyczka zapisuje postęp → widać w popupie)
- Lista wspieranych platform (jasno: MVP = Netflix + Disney+, reszta jako roadmap)
- Sekcja limitacji: selektory DOM mogą się zepsuć przy update'ach UI platformy — to świadome ryzyko tego typu projektu, nie ukrywać w README

---

## v2 (po działającym MVP)

- Dodanie Max — osobny content script, nowe selektory (uwaga: platforma przechodziła rebranding, sprawdź aktualną strukturę przed startem)
- Dodanie Prime Video — **najtrudniejszy z czterech**, mocno dynamiczny/zagnieżdżony DOM, zarezerwuj więcej czasu niż na pozostałe
- Ewentualnie: eksport historii do pliku / statystyki (najczęściej oglądana platforma, liczba obejrzanych w miesiącu)

---

## Szacunek czasu

- **MVP (Netflix + Disney+, pełen zestaw funkcji):** 16–20h
- **Każda kolejna platforma (Max, Prime Video):** +6–8h
- Prime Video: licz górną granicę tego przedziału lub więcej — trudniejszy DOM niż pozostałe trzy
