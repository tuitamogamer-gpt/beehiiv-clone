# Backend: izvedeno, provjereno i preostalo

U projekt je dodan stvaran serverski sloj za newsletter platformu: trajna pohrana, autentifikacija i ovlasti, radni red, pretplatnici i segmenti, objave i slanje, automatizacije, naplata, zajednica, podcasti, webhookovi, ograničeni MCP i AI pisanje. Operacije nad tim zapisima koriste API i bazu. Vanjske usluge aktiviraju se tek kad se konfiguriraju odgovarajući računi i ključevi.

To nije dovršena zamjena za svaki zahtjev s izvornog popisa. Posebno nisu izgrađeni vlastita globalna infrastruktura za dostavu, oglasna i preporučiteljska mreža, ljudski tim za podršku ili dostavljivost, istodobno kolaborativno uređivanje i webinar streaming. Stopa isporuke od 99,3% i kapacitet od 3 milijuna poruka u minuti nisu izmjereni ni zajamčeni ovim kodom. Brojke u izvornom demonstracijskom sučelju nisu dokazi produkcijskih rezultata; serverska analitika koristi zabilježene događaje.

## Što je implementirano

| Područje | Stvarno ponašanje u kodu | Preduvjeti i granice |
| --- | --- | --- |
| Baza i izolacija publikacija | PostgreSQL adapter, razvojni SQLite, transakcije, zaključavanje, optimistično verzioniranje, paginacija kursorom, odvajanje podataka po publikaciji | Produkcija zahtijeva PostgreSQL; nema tihog prelaska na lokalni SQLite. SQLite i PostgreSQL 17 adapteri te radni red testirani su izolirano, ne opterećenjem milijuna zapisa. |
| Korisnici i ovlasti | Lozinke zaštićene scryptom, serverske sesije, HttpOnly kolačić, admin/member/contributor, provjera aktualnog članstva na svakom zahtjevu, opoziv pristupa, zamjena publikacije | Produkcijska domena i stabilan `SESSION_SECRET`; administratorski račun kreira se kroz CLI, bez javne bootstrap rute. |
| Magic links i tim | Jednokratni vremenski ograničeni tokeni, pohrana hashova, stvarne pozivnice, dodjela uloga, zaštita posljednjeg administratora, opoziv pozivnice | Za slanje je potreban Resend. Nepovezan provider uzrokuje jasnu pogrešku; sustav ne prijavljuje izmišljeno poslanu poruku. |
| API ključevi | Stvarni Bearer ključevi, prikaz tajne jednom, hash u bazi, ovlasti po području, rok važenja i opoziv | API ključ ne zaobilazi provjeru članstva ili uloge; ne može stvarati druge ključeve. |
| Pretplatnici | CRUD, normalizacija e-adrese, sprječavanje duplikata pod konkurentnim zahtjevima, statusi Active/Pending/Unsubscribed, tagovi, izvor, prilagođena polja i povijest događaja | Sintaksa i lokalni popis poznatih jednokratnih/pogrešnih domena; produkcija dodatno provjerava MX. To nije dokaz vlasništva sandučića ili potpuna komercijalna provjera adrese. |
| Uvoz i izvoz | CSV s navodnicima i escapiranjem, preskakanje nevaljanih i dvostrukih redaka, očuvanje odjava i izvora; neutralizacija formula pri izvozu | Do 4 MB i 10.000 redaka po uvozu; produkcijski batch najviše 100 različitih domena zbog ograničenih DNS provjera. Veliki izvoz zasad učitava kolekciju u memoriju. |
| Javni upis | Ograničenje zahtjeva, honeypot, signal vremena ispunjavanja, Turnstile, izričit pristanak, opcionalni double opt-in uključen prema zadanim postavkama | U produkciji bez Turnstilea upis je blokiran. Double opt-in zahtijeva konfigurirano slanje; token se troši jednom i istječe nakon 24 sata. |
| Rast, obrasci i liste | Više newsletter lista, objavljivi obrasci s odvojenim nacrtom, iframe embed, UTM/form atribucija, preporuke, referral linkovi i pragovi nagrada, stvarni pageview događaji | Članstvo i referral kredit potvrđuju se nakon aktivacije/double opt-ina; duplicirani kredit se odbija. Nagrade se izvršavaju ručno. Nema globalne partnerske mreže, provizijskog obračuna ili naprednog anti-fraud sustava. |
| Segmenti | Statični članovi validirani unutar publikacije; dinamični uvjeti nad statusom, paketom, izvorom, tagovima, stvarnim poljima angažmana i custom poljima; ručni preračun i izvoz | Dinamični članovi računaju se pri čitanju. Spremljeni broj ima vrijeme zadnjeg preračuna. Preračun/izvoz velikih kolekcija treba prebaciti na streaming poslove prije velikog prometa. |
| Objave i predlošci | Trajni nacrti i predlošci, sanitizirani HTML, renderiranje email/web i free/premium varijanti, personalizacija, preview i kontrolirani tok zakazivanja/slanja | Renderer ne predstavlja Litmus/Email on Acid certifikaciju svih inbox klijenata. Istodobna kolaboracija, potpuni editor s izvornog popisa i sve vrste embedova nisu dovršeni. |
| Dostava | Integracija Resend API-ja, provjera spremnosti pošiljatelja, poslovi i primatelji po slanju, idempotentni zahtjevi provideru, zakazivanje, klasifikacija bounceova, odjava jednim klikom, potpisani ulazni događaji, suppression | Potrebni stvaran provider, verificirana domena i webhook. Status prihvaćanja poruke nije isto što i potvrđena dostava. Upravljanje IP poolom, vlastiti MTA i sve povratne petlje mailbox providera ostaju kod providera/operativnog tima. |
| Suppression | Globalni, publication i transactional opseg, trajni ili privremeni zapisi, automatsko ignoriranje isteklih zabrana; odjavljeni i nepotvrđeni čitatelji ne primaju marketing | Platformsku globalnu zabranu smije stvarati samo pouzdan događaj dostave; ručno dodavanje ne smije blokirati druge publikacije. |
| Automatizacije | Nacrt odvojen od žive verzije, validirani graf bez ciklusa, trigger/delay/email/condition/webhook, trajni journey i koraci, zakazani nastavak, idempotentni enrollment i provider zahtjevi, pauza/nastavak | Najviše 100 čvorova; jedan put kroz graf i uvjetno grananje. Nema petlji, paralelnih fork/join grana ni općeg workflow jezika. Worker/cron mora redovito obrađivati red. |
| Plaćanja i proizvodi | Proizvodi/varijante, kuponi, Stripe checkout, potpisani i idempotentni Stripe webhookovi, narudžbe, pretplate, portal, pauziranje/nastavak/otkazivanje, refund zahtjevi i vremenski ograničena preuzimanja | Potrebni Stripe ključevi, endpoint webhooka i privatna medijska pohrana. Kod ne dodaje platformsku naknadu, ali Stripe i infrastrukturne naknade ostaju. Stripe Connect marketplace/payouts, gifting i složeni grupni paketi nisu kompletirani. |
| Zajednica | Kanali, objave, komentari, prijave, moderacija, zabrane, poruke i ograničenje premium pristupa prema server-side entitlements | To je serverski temelj zajednice; nije puna zamjena za Discord, Luma ili sinkronizaciju svih vanjskih uloga. |
| Čitateljski računi | Zasebne reader sesije putem jednokratnog magic linka, samo za Active pretplatnike, povezivanje narudžbi i pristupa zajednici/premium sadržaju | Odvojeno od administratorskog članstva; potreban email provider i worker za dostavu linka. Plaćena prava provjeravaju se na serveru. |
| Mediji | Privatna knjižnica, ovlasti po publikaciji, upload/download, alt i caption metapodaci; Sharp optimizacija slika do 1920×1920 i WebP | Najviše 4 MB po datoteci. Produkcija zahtijeva privatni Vercel Blob; lokalni disk koristi se samo u razvoju. Velike podcast/video datoteke zahtijevaju dodatni upload/streaming dizajn. |
| Web sadržaj i predlošci | CRUD predložaka, zadani stilovi, nacrt/objava stranice, SEO polja, premium pristup, verzije i restore, redirecti te komentari na objavama | Serverske rute i sanitizirani prikaz; ne predstavlja dovršen AI/no-code builder ili real-time uređivanje. |
| Pollovi i ankete | Validirani tipovi pitanja, odgovori vezani uz aktivnog pretplatnika i token, zbirni rezultati, pojedinačni odgovori, događaji za webhook | Nema opće tvrdnje da je svaki inbox klijent ili skener poveznica neovisno provjeren. |
| Podcasti | Show i episode zapisi, očuvani GUID, objava/zakazivanje/arhiviranje, RSS i javne stranice, privatni feedovi s ponovnom provjerom pretplate, redirect feeda, ručni transkript | Distribucija u Apple/Spotify/YouTube zahtijeva ručnu predaju feeda. Automatski transkripti, IAB certificirana analitika i streaming infrastruktura nisu konfigurirani. |
| Webhookovi | Izbor događaja, verzija payloada, HMAC potpis, šifrirana tajna, rotacija, automatski retry, zapis svakog pokušaja, ručni retry i deaktivacija | Primatelj mora obrađivati događaje idempotentno. Izlazne URL-ove provjerava zaštita od SSRF-a. |
| Analitika | Stvarni zapisi pretplatnika, dostave, otvaranja/klikova, prodaje i web događaja; izvori, mailbox domene, prihod po valuti | Otvaranja uključuju ograničenja privacy proxya. Bot filtriranje je heuristika, nije komercijalno neovisno potvrđeno. Agregat je ograničen na 20.000 zapisa po kolekciji. |
| AI | Stvarni OpenAI pozivi za nacrt/prepisivanje/prijevod/gramatiku, generiranje slika, govor iz teksta i transkripciju audija; mediji se spremaju u privatnu knjižnicu | Potrebni OpenAI i produkcijska Blob pohrana. Slike su 1024×1024 low quality; govor do 4096 znakova; transkripcija audija do 4 MB. Nema automatskog cjelovitog newsletter→audio/podcast pipelinea ni univerzalnog AI agenta. |
| MCP | Autentificirani JSON-RPC endpoint, initialize/tools/list/tools/call i provjera istih API ovlasti | Ograničen skup alata: analitika, popis objava/pretplatnika/segmenata/automatizacija, povijest pretplatnika i izrada nacrta. To nije čitav izvorno traženi skup operacija niti dovršena OAuth distribucija za svaki AI klijent. |

Detalji ugovora i ruta nalaze se u [API pregledu](./API.md), [autentifikaciji](./auth.md), [publici/automatizacijama](./audience-automations.md), [rastu, obrascima i listama](./growth.md), [dostavi](./delivery.md), [integracijama](./integrations.md) i [naplati/zajednici/podcastima](./commerce-community-podcasts.md). Serverske module treba razlikovati od pokrivenosti pojedinačnih ekrana: nisu sve API mogućnosti predstavljene zasebnim dovršenim UI tokom.

## Trenutačno stanje deploymenta

Produkcijski `APP_URL` postavljen je na `https://beehiiv-clone-mu.vercel.app`. U Vercel projekt već su dodane generirane tajne `SESSION_SECRET`, `UNSUBSCRIBE_SECRET` i `CRON_SECRET`; njihove vrijednosti nisu navedene u dokumentaciji i ne treba ih ponovno generirati radi inicijalnog postavljanja. Sama tajna za scheduler ne uključuje izvršavanje poslova. `SCHEDULER_ENABLED=true` postavlja se tek nakon stvarne konfiguracije i provjere radnika ili rasporeda.

I dalje treba povezati produkcijsku bazu, stvarne providere i njihove webhookove te kreirati početnog administratora. Postojanje deployment URL-a nije potvrda da je produkcijska baza dostupna ili da su email, plaćanja i worker aktivni. Nije konfiguriran automatski cron koji bi se izvršavao svake minute.

## Konfiguracija vanjskih servisa

Tajne postaviti kroz lokalni nekomitirani `.env` ili upravljanje varijablama odabrane hosting platforme. Vrijednosti ključeva ne upisivati u frontend, kod, screenshotove ni ovaj dokument.

| Varijabla | Namjena | Kada je potrebna |
| --- | --- | --- |
| `APP_URL` | Kanonski URL aplikacije, origin provjera, linkovi za potvrdu i prijavu | U produkciji javni HTTPS URL; mora odgovarati stvarnoj domeni aplikacije. |
| `DATABASE_URL` ili `POSTGRES_URL` | PostgreSQL konekcija | Obavezno u produkciji. Koristiti dostupno povezivanje i backup mogućnosti odabranog providera. |
| `SQLITE_PATH` | Lokalna razvojna baza | Samo razvoj/testiranje; zadano `.data/newsletter.sqlite`. |
| `SESSION_SECRET` | Serversko potpisivanje/tokeni i šifriranje webhook tajni | Stabilna nasumična vrijednost od barem 32 znaka. Rotacija utječe na postojeće sesije, potpisane linkove i šifrirane webhook tajne. |
| `RESEND_API_KEY` | Stvarno slanje emaila i upravljanje verificiranom domenom | Newsletter slanje, potvrde upisa, magic links i pozivnice. |
| `RESEND_WEBHOOK_SECRET` | Provjera izvornosti ulaznih email događaja | Potvrđena dostava, bounce/complaint događaji i pouzdana analitika. |
| `EMAIL_FROM` | Pošiljatelj sistemskih poruka | Mora biti dopušten i verificiran kod providera. Publikacijski pošiljatelj dodatno podliježe vlastitoj provjeri spremnosti. |
| `TURNSTILE_SECRET_KEY` | Serverska provjera anti-bot tokena | Obavezno za produkcijski javni upis. |
| `TURNSTILE_SITE_KEY` | Javni identifikator Turnstile widgeta | Za prikaz stvarne provjere u javnom obrascu. Tajni ključ se nikad ne šalje pregledniku. |
| `STRIPE_SECRET_KEY` | Checkout, pretplate, portal i refund API | Potrebno za stvarne transakcije; prvo testni način. |
| `STRIPE_WEBHOOK_SECRET` | Provjera potpisa Stripe događaja | Dodjela plaćenih prava tek nakon potvrđenog događaja. |
| `BLOB_READ_WRITE_TOKEN` | Produkcijska pohrana medija | Za aktivaciju Vercel Blob integracije i privatne isporuke datoteka. |
| `OPENAI_API_KEY` | Generiranje/uređivanje teksta | Samo za AI funkcije. |
| `OPENAI_TEXT_MODEL` | Odabir OpenAI tekstualnog modela | Neobavezno; zadana vrijednost je određena u integracijskom modulu. |
| `CRON_SECRET` | Autentifikacija endpointa za worker | Već generiran u Vercel projektu; scheduler treba zasebno uključiti. |
| `UNSUBSCRIBE_SECRET` | Potpisivanje linkova za odjavu | Već generiran u Vercel projektu; čuvati stabilnim za postojeće linkove. |
| `SCHEDULER_ENABLED` | Izričita potvrda da postoji aktivni raspored | Postaviti `true` tek nakon stvarnog uključivanja schedulera. |

Sama prisutnost varijable ne dokazuje da su račun, domena, ugovoreni limiti ili webhook ispravni. Prije produkcijskog aktiviranja treba proći stvarnu provjeru odgovarajućeg providera.

## Sigurnost i obrada poslova

Autorizacija koristi identitet s provjerene serverske sesije ili API ključa, a ne `tenantId` iz tijela korisničkog zahtjeva. Pohrana je parametrizirana; ID je jedinstven unutar vrste zapisa i publikacije. Stari `version` odbija se pri izmjeni. Operacije koje stvaraju pretplatnika ili enrollment koriste transakcijsko zaključavanje.

Red poslova sprema stanje, broj pokušaja, sljedeći termin, grešku i lease vlasnika. Konkurentni worker procesi ne preuzimaju isti aktivni posao; istekli lease može se oporaviti. Privremene greške dobivaju odgođeni retry; trajne validacijske greške i iscrpljeni pokušaji prelaze u failed. To je obrada barem jednom, pa se vanjski učinci dodatno štite provider idempotency ključevima. Tuđi webhook primatelji moraju poštovati dostavljeni identifikator događaja.

Vanjski proizvoljni URL-ovi ograničeni su na javni HTTPS. Provjeravaju se DNS adrese, privatni/rezervirani IPv4 i IPv6 rasponi i IPv4-mapped zapisi; izlazna konekcija vezana je uz provjerenu adresu. Redirecti se ne slijede automatski. Ograničenja trajanja i veličine odgovora sprječavaju beskonačne vanjske odgovore. To ne zamjenjuje infrastrukturna egress pravila i nadzor produkcijskih servisa.

Pogreška konfiguracije ili providera vraća stvarnu neuspješnu operaciju. Ne stvaraju se fiktivna plaćanja, poslani newsletteri ili dostavljene poruke kako bi ekran izgledao aktivno.

## Pokretanje i produkcijska aktivacija

Potrebni su Node.js 24 i instalirane ovisnosti. Izvorni frontend koristi Vite; backend je Hono aplikacija s rutama pod `/api`. Lokalni server i Vercel entrypoint dijele iste module i provjere. Naredbe iz `package.json`:

```sh
npm install
npm run db:migrate
npm run db:bootstrap
npm run dev:api
```

`db:bootstrap` čita `ADMIN_EMAIL`, `ADMIN_PASSWORD` (najmanje 12 znakova), `ADMIN_NAME` i `PUBLICATION_NAME` iz privatnog okruženja. Postaviti ih u nekomitirani `.env`, pokrenuti bootstrap i zatim ukloniti početnu lozinku iz te datoteke. CLI ne prima lozinku kao javni URL ni kao argument naredbenog retka. U drugom terminalu `npm run dev` pokreće Vite koji prosljeđuje `/api` lokalnom backendu. Poziv `npm run worker -- --once` obrađuje jedan batch; `npm run worker` pokreće trajnog lokalnog radnika.

Produkcijski scheduler treba svake minute zvati `GET /api/jobs/run` s headerom `Authorization: Bearer <CRON_SECRET>`. Tajnu postaviti u secret manager schedulera. Vercel cron svake minute može zahtijevati odgovarajući plaćeni plan; alternativno se može koristiti zasebni radnik ili vanjski scheduler. U deployment nije uključen automatski raspored koji bi to već radio.

Redoslijed konfiguracije:

1. Postaviti bazu, stabilan serverski secret i kanonski URL. Pokrenuti migracije i izraditi početnog administratora kroz CLI.
2. Prijaviti se, provjeriti odvajanje publikacija, uloge i opoziv API ključa te potvrditi da podaci prežive restart servera.
3. Povezati Resend, dodati stvarne DNS zapise koje provider izdaje i potvrditi domenu. Konfigurirati i testirati potpisani Resend webhook. Izvesti malo stvarno testno slanje na adrese pod vlastitom kontrolom.
4. Konfigurirati Turnstile widget/domenu i serverski secret; provjeriti stvarni upis i jednokratnu potvrdu. Bez toga produkcijski javni upis ostaje nedostupan.
5. Postaviti radnik ili cron koji redovito poziva obradu poslova. Web hosting koji samo prima HTTP zahtjeve ne izvršava odgođene poslove sam od sebe.
6. Povezati Stripe u testnom načinu, webhook i privatnu pohranu; provjeriti plaćanje, ponovljeni webhook, ukidanje pretplate, refund i prestanak pristupa. Tek zatim prijeći na produkcijske ključeve.
7. Po potrebi uključiti OpenAI, vanjske webhook primatelje i MCP klijent s ograničenim ključem. Provjeriti stvarne troškove i limite odabranih usluga.
8. Postaviti backup, restore probu, alerting za failed poslove i webhookove, evidenciju grešaka, ograničenje troškova i operativno vlasništvo. Ti servisi i procesi nisu automatski kupljeni niti uvedeni ovim kodom.

Za Vercel posebno treba osigurati dostupnu PostgreSQL bazu, varijable u odgovarajućem deployment okruženju, konfiguriran cron/worker i pohranu izvan efemernog filesystema funkcije. Lokalna SQLite datoteka nije produkcijska baza na Vercelu.

## Provjera

Testovi se nalaze u `server/tests` i koriste stvarni SQLite adapter u memoriji te injektirane transporte za email/plaćanja gdje je primjenjivo. Ne šalju stvarne newslettere i ne provode naplatu. Njima su obuhvaćeni pozitivni tokovi, izolacija publikacija, uloge i scopeovi, konkurentno stvaranje i izvršavanje, rollback/CAS, paginacija, jednokratni tokeni, suppression, validacija workflow grafova, retry, potpisivanje i odbijanje SSRF odredišta.

Ciljana provjera publike: `npx tsx --test server/tests/audience.test.ts`.

Ciljana provjera automatizacija: `npx tsx --test server/tests/automations.test.ts`.

Provjera infrastrukture: `npx tsx --test server/tests/infrastructure.test.ts server/tests/network.test.ts`.

Puni serverski testovi: `npm run test:backend`. Integrirana provjera aplikacije i origin zaštite: `npx tsx --test server/tests/app-security.test.ts`. Serverski tipovi: `npm run typecheck:server`. Build i završni rezultat svih provjera trebaju se čitati iz posljednjeg izvršavanja u istom checkoutu, a ne iz statičnog obećanja u ovom dokumentu.

Dodatno je uspješno pokrenuto šest provjera na stvarnom PostgreSQL 17 poslužitelju u privremenom Docker kontejneru: JSONB filteri i kursori, izolacija, transakcijski rollback, konkurentni CAS, advisory locks kroz dva connection poola, idempotencija/preuzimanje poslova te kreiranje računa i sesije. Kontejner je nakon testa uklonjen. Reprodukcija: usmjeriti `TEST_DATABASE_URL` na namjensku praznu testnu PostgreSQL bazu i pokrenuti `npx tsx --test server/tests/postgres.test.ts`; bez te varijable test se preskače. Test ne treba pokretati nad produkcijskom bazom.

Lokalni testovi nisu end-to-end certifikacija produkcijskog PostgreSQL clustera, email reputacije, Stripe računa, Vercel deploymenta ili stvarnog load testa. Za njihove tvrdnje potrebna je zasebna provjera s konfiguriranim servisima.

## Što i dalje ostaje iz izvornog popisa

- Vlastiti SLA dostavljivosti, 99,3% potvrđena isporuka, infrastruktura 3M+ emaila/min, vlastito zagrijavanje i rotacija IP adresa, članstvo u svim feedback programima i stalni stručni tim.
- Potpuna kompatibilnost sa svakim inbox klijentom potvrđena rendering servisom; komplet svih naprednih blokova editora, Google Docs paste fidelity, stvarna simultana kolaboracija i komentiranje vezano uz točan sadržaj dokumenta.
- Velika vlastita ad/recommendation mreža, ugovoreni oglašivači, plaćene preporuke s neovisnim fraud/clawback sustavom, produkcijski referral/reward fulfillment i partnerski billing.
- Nativni live webinar streaming za 10.000 gledatelja, recording pipeline, live chat/video delivery, booking kalendari i puna obrada reminder/calendar tokova.
- AI website builder iz prompta/screenshotova, sve gotove integracije i univerzalni AI agent sa stotinama akcija; automatsko pretvaranje cijelog newslettera u dugi audio/podcast. Osnovne AI slike, kratki govor i transkripcija imaju stvarne API rute, uz gore navedene limite.
- Potpuno upravljanje custom domenama hostinga, sve SEO/robots/Google News sheme, dokaz ubrzanja LCP-a od 80%, napredna politika AI crawlera i potpuno uređivanje weba povlačenjem elemenata.
- Automatski prijenos podcasta na sve direktorije, automatsko vezivanje transkripcije uz svaku objavljenu epizodu, IAB certificirana statistika, opsežan media transcoding i CDN operacije.
- Stripe Connect payouts, sve kombinacije darovnih/grupnih pretplata, seat management, vremenski i plaćeni trialovi te kompletan storefront UX za svaki tip proizvoda.
- Potpuno produkcijsko skaliranje, backup/restore operativa, kontinuirani nadzor, on-call podrška, sigurnosni audit, politike čuvanja podataka i operativni ugovori s providerima.

Primjenjivi troškovi ostaju kod hostinga, baze, email providera, naplate, pohrane, AI servisa i eventualnog nadzora. Zahtjev za odsutnošću platformskog postotka nije isto što i besplatan rad cijelog sustava.
