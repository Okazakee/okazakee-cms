-- Isolated fixture seed: minimal, deterministic content for the CMS.
--
-- Applied after the baseline schema and the repository migrations. All asset
-- URLs point at the loopback Storage endpoint so the fixture never depends on
-- (or reads) the production project.

-- Re-runnable against a freshly reset database.
truncate table
  public.hero_section,
  public.i18n_translations,
  public.contacts,
  public.skills,
  public.skills_categories,
  public.career_entries,
  public.blog_posts,
  public.portfolio_posts,
  public.cms_allowed_users
restart identity cascade;

insert into public.hero_section
  (id, name, role, about, propic, "blurhashURL", resume_en, resume_it)
values
  (1,
   'Isolated Fixture',
   'Test Engineer',
   'Deterministic local fixture content.',
   'http://127.0.0.1:54321/storage/v1/object/public/website-dev/avatar/avatar.png',
   'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
   'http://127.0.0.1:54321/storage/v1/object/public/website-dev/resume/resume_en.pdf',
   'http://127.0.0.1:54321/storage/v1/object/public/website-dev/resume/resume_it.pdf');

insert into public.i18n_translations (language, translations, privacy_policy)
values
  ('en',
   '{"nav":{"home":"Home","blog":"Blog"},"hero":{"greeting":"Hello"}}'::jsonb,
   '# Privacy policy\n\nIsolated fixture.'),
  ('it',
   '{"nav":{"home":"Home","blog":"Blog"},"hero":{"greeting":"Ciao"}}'::jsonb,
   '# Privacy policy\n\nFixture isolato.');

insert into public.contacts (label, icon, link, bg_color, position)
values
  ('GitHub', 'github', 'https://github.com/example', '#111111', 0),
  ('Email', 'mail', 'mailto:fixture@isolated.test', '#222222', 1);

insert into public.skills_categories (id, name, position)
values
  (1, 'Languages', 0),
  (2, 'Tooling', 1);

insert into public.skills (title, icon, invert, category_id, "blurhashURL")
values
  ('TypeScript', 'http://127.0.0.1:54321/storage/v1/object/public/website-dev/avatar/avatar.png', false, 1, null),
  ('Rust', 'http://127.0.0.1:54321/storage/v1/object/public/website-dev/avatar/avatar.png', true, 1, null),
  ('Docker', 'http://127.0.0.1:54321/storage/v1/object/public/website-dev/avatar/avatar.png', false, 2, null);

insert into public.career_entries
  (title, company, website_url, logo, blurhashurl, location_en, location_it,
   remote, "startDate", "endDate", description_en, description_it, skills,
   company_description_en, company_description_it)
values
  ('Senior Engineer', 'Fixture Corp', 'https://example.com', null, null,
   'Remote', 'Remoto', 'full', '2022-01', null,
   'Built deterministic fixtures.', 'Costruito fixture deterministiche.',
   'TypeScript,Docker', 'A test company.', 'Una societa di test.'),
  ('Engineer', 'Fixture Labs', 'https://example.org', null, null,
   'Hybrid', 'Ibrido', 'hybrid', '2020-01', '2021-12',
   'Shipped isolated tests.', 'Rilasciato test isolati.',
   'Rust', 'A lab.', 'Un laboratorio.');

insert into public.blog_posts
  (title_en, title_it, image, description_en, description_it, body_en,
   body_it, "blurhashURL", post_tags, views, hidden, author_id)
values
  ('Fixture post one', 'Post fixture uno',
   'http://127.0.0.1:54321/storage/v1/object/public/website-dev/blog/post-1.png',
   'First fixture description.', 'Prima descrizione fixture.',
   '# Body one', '# Corpo uno', 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
   'fixture,test', 3, false, null),
  ('Fixture post two', 'Post fixture due',
   'http://127.0.0.1:54321/storage/v1/object/public/website-dev/blog/post-2.png',
   'Second fixture description.', 'Seconda descrizione fixture.',
   '# Body two', '# Corpo due', 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
   'fixture', 0, true, null);

insert into public.portfolio_posts
  (title_en, title_it, image, source_link, demo_link, description_en,
   description_it, body_en, body_it, "blurhashURL", post_tags, store_link,
   fdroid_link, website, ios_store_link, views, hidden, author_id)
values
  ('Fixture project', 'Progetto fixture',
   'http://127.0.0.1:54321/storage/v1/object/public/website-dev/portfolio/app.png',
   'https://example.com/source', 'https://example.com/demo',
   'Fixture project description.', 'Descrizione progetto fixture.',
   '# Project', '# Progetto', 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
   'fixture,app', 'https://example.com/store', null,
   'https://example.com', null, 7, false, null);

insert into public.cms_allowed_users (email, github_username, role)
values
  ('admin@isolated.test', 'fixture-admin', 'admin'),
  ('editor@isolated.test', 'fixture-editor', 'editor');

-- Match the public-copy namespaces the website still reads, with deterministic
-- non-production labels. Header and footer chrome is deliberately absent: it is
-- frozen in the site repo (src/i18n/messages/site.{en,it}.json) and is no longer
-- stored in i18n_translations.
update public.i18n_translations set translations = translations || '{
  "hero-section": {"top":{"name":"Fixture author","role":"Software developer"},"aboutme":{"title":"About me","paragraph":"Building deterministic tools"}},
  "skills-section": {"title":"Skills","subtitle":"Tools for the work"},
  "career-section": {"title":"Career","subtitle":"Experience and learning","month":"month","months":"months","year":"year","years":"years","present":"Present","remote":{"full":"Remote","hybrid":"Hybrid","onSite":"On site"}},
  "portfolio-section": {"title":"Portfolio","description":"Selected projects"},
  "blog-section": {"title":"Blog","description":"Notes and ideas"},
  "contacts-section": {"title":"Contacts","subtitle":"Get in touch","resume":"Download resume"},
  "posts-section": {"title1":"Portfolio","subtitle1":"Selected projects","title2":"Blog","subtitle2":"Notes and ideas","button":"Read more","no-posts":"No posts yet","source":"Source","demo":"Demo","store":"Google Play","fdroid":"F-Droid","ios":"App Store","preCopy":"Copy link","ratelimit":"Please try again later","searchbar":"Search posts"},
  "privacyPolicy": {"description":"How this fixture handles data"},
  "errors": {"code":"404","notFoundLabel":"Not found","notFoundTitle":"Page missing","notFoundText":"This page does not exist","goBack":"Go back","home":"Home","errorLabel":"Error","errorTitle":"Something went wrong","errorText":"Please try again","retry":"Retry","postErrorTitle":"Post unavailable","postErrorText":"Please try again later","postNotFoundText":"This post does not exist"},
  "request-form": {"eyebrow":"Project requests","title":"Have a project in mind?","subtitle":"Tell me about it","website":"Website","websitePlaceholder":"https://example.test","name":"Name","namePlaceholder":"Your name","email":"Email","emailPlaceholder":"you@example.test","company":"Company","companyPlaceholder":"Your company","type":"Project type","typeOptions":["Select type","Website","App"],"budget":"Budget","budgetOptions":["Select budget","Under 1000","1000 to 5000"],"timeline":"Timeline","timelineOptions":["Select timeline","This month","Flexible"],"request":"Request","requestPlaceholder":"Describe your project","consent":"I accept the privacy policy","submit":"Send request","comingSoon":"Coming soon"}
}'::jsonb;

update public.i18n_translations set translations = translations || '{
  "skills-section": {"title":"Competenze","subtitle":"Strumenti per il lavoro"},
  "career-section": {"title":"Carriera","subtitle":"Esperienza e formazione","month":"mese","months":"mesi","year":"anno","years":"anni","present":"Presente","remote":{"full":"Remoto","hybrid":"Ibrido","onSite":"In sede"}},
  "portfolio-section": {"title":"Portfolio","description":"Progetti selezionati"},
  "blog-section": {"title":"Blog","description":"Note e idee"},
  "contacts-section": {"title":"Contatti","subtitle":"Restiamo in contatto","resume":"Scarica curriculum"},
  "posts-section": {"title1":"Portfolio","subtitle1":"Progetti selezionati","title2":"Blog","subtitle2":"Note e idee","button":"Leggi di più","no-posts":"Ancora nessun post","source":"Codice","demo":"Demo","store":"Google Play","fdroid":"F-Droid","ios":"App Store","preCopy":"Copia link","ratelimit":"Riprova più tardi","searchbar":"Cerca articoli"},
  "request-form": {"eyebrow":"Richieste di progetto","title":"Hai un progetto in mente?","subtitle":"Raccontami la tua idea","website":"Sito web","websitePlaceholder":"https://example.test","name":"Nome","namePlaceholder":"Il tuo nome","email":"Email","emailPlaceholder":"tu@example.test","company":"Azienda","companyPlaceholder":"La tua azienda","type":"Tipo di progetto","typeOptions":["Scegli tipo","Sito web","App"],"budget":"Budget","budgetOptions":["Scegli budget","Meno di 1000","1000 a 5000"],"timeline":"Tempistiche","timelineOptions":["Scegli tempistiche","Questo mese","Flessibile"],"request":"Richiesta","requestPlaceholder":"Descrivi il progetto","consent":"Accetto la privacy policy","submit":"Invia richiesta","comingSoon":"Prossimamente"}
}'::jsonb where language = 'it';

-- Explicit category IDs must not collide with the first created category.
select setval(pg_get_serial_sequence('public.skills_categories', 'id'), (select max(id) from public.skills_categories));

-- Fixture audit starts clean: only app-level writes are observed.
truncate table public._fixture_writes restart identity;
