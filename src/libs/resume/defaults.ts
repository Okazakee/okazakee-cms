/**
 * Seed resume content for both locales, transcribed from the author's
 * print-perfect HTML files. Used when no sources exist in Storage yet
 * (first run) and as the revert baseline.
 */
import type { ResumeData } from './types';

export const DEFAULT_EN: ResumeData = {
  name: 'Cristian Di Carlo',
  title: 'Full-Stack & Mobile Engineer · TypeScript · React Native / Node.js',
  contacts: [
    { icon: 'location', text: 'Italy' },
    { icon: 'phone', text: '+39 3883628480', href: 'tel:+393883628480' },
    {
      icon: 'email',
      text: 'okazakee@proton.me',
      href: 'mailto:okazakee@proton.me',
    },
    { icon: 'github', text: 'Github', href: 'https://github.com/okazakee' },
    {
      icon: 'linkedin',
      text: 'Linkedin',
      href: 'https://linkedin.com/in/okazakee',
    },
    { icon: 'website', text: 'okazakee.dev', href: 'https://okazakee.dev' },
    { icon: 'document', text: 'IT02863310815' },
  ],
  summaryTitle: 'Professional Summary',
  summaryHtml:
    'Full-stack and mobile engineer focused on <strong>TypeScript</strong>, <strong>React Native / Expo</strong>, <strong>React / Next.js</strong>, and <strong>Node.js / NestJS</strong>. Experienced shipping <span class="nowrap">end-to-end</span> product features across mobile, web, and backend, including <strong>authentication</strong>, <strong>payments</strong>, <strong>offline/local-first data</strong>, API integrations, testing, and delivery infrastructure. Recent work spans fintech/payments and open-source developer tooling, with a strong focus on pragmatic architecture, maintainability, and ownership.',
  skillsTitle: 'Technical Skills',
  skills: [
    {
      label: 'Core',
      tags: [
        'TypeScript',
        'JavaScript',
        'React',
        'React Native',
        'Expo',
        'Next.js',
        'Bun',
      ],
    },
    {
      label: 'Backend & Data',
      tags: [
        'Node.js',
        'NestJS',
        'REST / OpenAPI',
        'PostgreSQL',
        'SQLite',
        'Supabase',
        'WebSockets',
      ],
    },
    {
      label: 'Testing & Delivery',
      tags: [
        'Jest',
        'Maestro E2E',
        'Docker',
        'GitHub Actions',
        'Git',
        'Linux',
        'Vercel',
      ],
    },
    {
      label: 'AI & Agentic Workflow',
      tags: [
        'Multi-agent orchestration',
        'Task delegation',
        'Auto review loops',
        'MCP',
        'CLI agents',
      ],
    },
  ],
  experienceTitle: 'Professional Experience',
  experience: [
    {
      title: 'Full-Stack Software Engineer · Payments',
      sub: 'paid24/7 · Blox Space · Turin, Italy (Hybrid)',
      meta: 'May 2026 – Aug 2026',
      bullets: [
        'Contributed to a fintech/payment product across frontend and authentication flows, including <strong>localization</strong> and <strong>email OTP</strong> implementation.',
        'Researched and specified integrations across <strong>UR / Fiat24</strong>, <strong>Privy</strong>, <strong>Gnosis Pay</strong>, and Bitcoin wallet infrastructure, translating provider capabilities into implementation plans and technical decisions.',
        'Worked with technical and product stakeholders on <strong>MVP scope</strong>, payment flows, KYC, wallet architecture, and the evolution from managed custody toward non-custodial capabilities.',
      ],
    },
    {
      title: 'React Native Engineer',
      sub: 'Portal Technologies Inc · Brescia, Italy (Hybrid)',
      meta: 'Apr 2025 – Apr 2026',
      bullets: [
        'Developed and maintained a production <strong>React Native + Expo</strong> application spanning payments, identity, local state, offline behavior, and native platform integrations.',
        'Shipped features including <strong>AppLock</strong> security, <strong>cloud backup</strong> backed by <strong>Kotlin/Swift</strong> native modules, <strong>Nostr / NIP-05</strong> identity functionality, and Bitcoin/Lightning integrations using <strong>Breez SDK</strong> and <strong>NWC</strong>.',
        'Improved reliability and maintainability through refactoring, <strong>Biome</strong>, <strong>Jest</strong>, and <strong>Maestro E2E</strong> while contributing across mobile, protocol, and supporting backend layers.',
      ],
    },
    {
      title: 'Frontend Developer',
      sub: 'Enhancers · Tinexta Group · Turin, Italy (Remote)',
      meta: 'Aug 2023 – Jul 2024',
      bullets: [
        "Built production frontend features for Tecnoalarm's <strong>Angular IoT device-management platform</strong> and Illumia's <strong>React customer portal</strong>, translating <strong>Figma specifications</strong> into responsive interfaces and integrating backend APIs.",
        'Collaborated with backend teams on <strong>IoT data integrations</strong> and improved application responsiveness through <strong>component-level performance optimization</strong> and adherence to shared <strong>design-system guidelines</strong>.',
      ],
    },
    {
      title: 'Frontend / Full-Stack Developer',
      sub: 'Entiende SRL · Naples, Italy (Remote)',
      meta: 'Jan 2023 – Aug 2023',
      bullets: [
        "Built <strong>responsive landing pages</strong> for TIM advertising campaigns, features for the company's <strong>Angular back-office CRM</strong>, and maintained the main company website.",
        'Designed a real-time notification system with <strong>NestJS</strong> and <strong>Socket.io</strong>, connecting an Express.js backend to the Angular frontend and surfacing conversion/lead events in real time.',
      ],
    },
  ],
  projectsTitle: 'Projects',
  projects: [
    {
      name: 'BlurKit',
      links: [
        { label: 'GitHub', href: 'https://github.com/Okazakee/blurkit' },
        { label: 'Website', href: 'https://blurkit.okazakee.dev/' },
        { label: 'npm', href: 'https://www.npmjs.com/package/blurkit' },
      ],
      stack: 'TypeScript · pnpm · turbo · tsup · sharp · BlurHash / ThumbHash',
      bullets: [
        '<strong>Universal image placeholder library</strong> published to <strong>npm</strong> that generates blurhash/thumbhash placeholders for Node, Bun, Deno, browser, edge, Cloudflare, and WASM runtimes from a single <strong>unified API</strong>.',
        'Built as a <strong>multi-runtime package</strong> with explicit entrypoints per runtime, <strong>CLI</strong> for single images and folder manifests, and cache helpers for Node and Cloudflare.',
      ],
    },
    {
      name: 'MinePanel',
      links: [
        { label: 'GitHub', href: 'https://github.com/MinePanelProject' },
        { label: 'Website', href: 'https://minepanel.xyz' },
      ],
      stack:
        'NestJS · Bun · PostgreSQL · Docker · GitHub Actions · React · Svelte',
      bullets: [
        'Building a <strong>self-hosted Minecraft server management platform</strong> with a tested NestJS/Bun backend, authentication and authorization flows, PostgreSQL migrations, and Docker-based deployment.',
        'Established <strong>CI/CD and container release workflows</strong> with migration, E2E, image smoke, vulnerability, trusted Docker, and multi-architecture publishing checks.',
      ],
    },
    {
      name: 'PearLift',
      links: [
        { label: 'GitHub', href: 'https://github.com/Okazakee/PearLift' },
        { label: 'Website', href: 'https://pearlift.okazakee.dev/' },
      ],
      stack:
        'React Native · Expo · TypeScript · SQLite · Holepunch / Pear · Maestro',
      bullets: [
        'Built a <strong>local-first workout tracker</strong> with no accounts or centralized backend, storing data in SQLite and synchronizing devices directly through <strong>peer-to-peer</strong> Holepunch connections.',
        'Implemented multi-day programs, a background rest timer, QR-based backup/transfer flows, and <strong>Maestro</strong> E2E testing.',
      ],
    },
    {
      name: 'PreCall',
      links: [
        { label: 'GitHub', href: 'https://github.com/Okazakee/PreCall' },
        { label: 'npm', href: 'https://www.npmjs.com/package/precall' },
      ],
      stack: 'TypeScript · Bun · Zod · LangChain · Resend · npm',
      bullets: [
        'Built and published a <strong>provider-neutral TypeScript library</strong> for turning structured client inquiries into AI-assisted pre-call briefs, with <strong>pluggable AIAdapter and EmailTransport</strong> integrations.',
        'Designed explicit <strong>privacy and reliability boundaries</strong> with <strong>per-field AI/output permissions</strong>, <strong>strict schema validation</strong>, preserved submissions, and <strong>graceful fallback behavior</strong> when AI or delivery fails.',
      ],
    },
    {
      name: 'Okazakee-WS CMS',
      links: [
        {
          label: 'GitHub',
          href: 'https://github.com/Okazakee/okazakee-cms',
        },
      ],
      stack: 'Next.js 16 · TypeScript · Supabase · WebAuthn · Vitest · BlurKit',
      bullets: [
        'Built a <strong>standalone content-management application</strong> for okazakee.dev covering multilingual content, portfolio/blog publishing, previews, uploads, and shared Supabase-backed storage.',
        'Implemented <strong>GitHub OAuth + WebAuthn passkeys</strong>, <strong>server-enforced RBAC</strong>, secure image processing with <strong>BlurKit</strong>, and <strong>HMAC-signed cache invalidation</strong> between the CMS and the public website.',
      ],
    },
  ],
  educationTitle: 'Education',
  education: [
    {
      degree: 'NextJS Development Course',
      school: 'Udemy',
      year: '2022',
    },
    { degree: 'Web Developer Course', school: 'Udemy', year: '2021' },
    {
      degree: 'Commercial Technical Institute',
      school: 'ITC G.B. Ferrigno · Castelvetrano, Italy',
      year: '2013 – 2018',
    },
  ],
  languagesTitle: 'Languages',
  languages: [
    { name: 'Italian', level: 'Native' },
    { name: 'English', level: 'C1 – Technical fluency' },
  ],
};

export const DEFAULT_IT: ResumeData = {
  name: 'Cristian Di Carlo',
  title: 'Ingegnere Full-Stack & Mobile · TypeScript · React Native / Node.js',
  contacts: [
    { icon: 'location', text: 'Italia' },
    { icon: 'phone', text: '+39 3883628480', href: 'tel:+393883628480' },
    {
      icon: 'email',
      text: 'okazakee@proton.me',
      href: 'mailto:okazakee@proton.me',
    },
    { icon: 'github', text: 'Github', href: 'https://github.com/okazakee' },
    {
      icon: 'linkedin',
      text: 'Linkedin',
      href: 'https://linkedin.com/in/okazakee',
    },
    { icon: 'website', text: 'okazakee.dev', href: 'https://okazakee.dev' },
    { icon: 'document', text: 'IT02863310815' },
  ],
  summaryTitle: 'Profilo Professionale',
  summaryHtml:
    'Ingegnere full-stack e mobile focalizzato su <strong>TypeScript</strong>, <strong>React Native / Expo</strong>, <strong>React / Next.js</strong> e <strong>Node.js / NestJS</strong>. Esperienza nello sviluppo <span class="nowrap">end-to-end</span> di funzionalità di prodotto su mobile, web e backend, inclusi <strong>autenticazione</strong>, <strong>pagamenti</strong>, <strong>dati offline/local-first</strong>, integrazioni API, testing e infrastruttura di delivery. Esperienza recente in ambito fintech/pagamenti e developer tooling open source, con forte attenzione ad architetture pragmatiche, manutenibilità e ownership.',
  skillsTitle: 'Competenze Tecniche',
  skills: [
    {
      label: 'Principali',
      tags: [
        'TypeScript',
        'JavaScript',
        'React',
        'React Native',
        'Expo',
        'Next.js',
        'Bun',
      ],
    },
    {
      label: 'Backend & Dati',
      tags: [
        'Node.js',
        'NestJS',
        'REST / OpenAPI',
        'PostgreSQL',
        'SQLite',
        'Supabase',
        'WebSockets',
      ],
    },
    {
      label: 'Testing & Delivery',
      tags: [
        'Jest',
        'Maestro E2E',
        'Docker',
        'GitHub Actions',
        'Git',
        'Linux',
        'Vercel',
      ],
    },
    {
      label: 'AI & Agentic Workflow',
      tags: [
        'Orchestrazione multi-agente',
        'Delega task',
        'Loop di review',
        'MCP',
        'Agenti CLI',
      ],
    },
  ],
  experienceTitle: 'Esperienza Professionale',
  experience: [
    {
      title: 'Full-Stack Software Engineer · Pagamenti',
      sub: 'paid24/7 · Blox Space · Torino, Italia (Ibrido)',
      meta: 'Mag 2026 – Ago 2026',
      bullets: [
        "Contribuito allo sviluppo di un prodotto fintech/pagamenti su frontend e flussi di autenticazione, inclusa l'implementazione di <strong>localizzazione</strong> ed <strong>email OTP</strong>.",
        'Analizzato e definito integrazioni con <strong>UR / Fiat24</strong>, <strong>Privy</strong>, <strong>Gnosis Pay</strong> e infrastrutture wallet Bitcoin, traducendo le capacità dei provider in piani di implementazione e decisioni tecniche.',
        "Collaborato con stakeholder tecnici e di prodotto su <strong>scope dell'MVP</strong>, flussi di pagamento, KYC, architettura wallet ed evoluzione dalla custodia gestita verso funzionalità non-custodial.",
      ],
    },
    {
      title: 'React Native Engineer',
      sub: 'Portal Technologies Inc · Brescia, Italia (Ibrido)',
      meta: 'Apr 2025 – Apr 2026',
      bullets: [
        "Sviluppata e mantenuta un'applicazione production <strong>React Native + Expo</strong> che integra pagamenti, identità, stato locale, comportamento offline e integrazioni native di piattaforma.",
        'Rilasciate funzionalità tra cui sicurezza <strong>AppLock</strong>, <strong>cloud backup</strong> tramite moduli nativi <strong>Kotlin/Swift</strong>, identità <strong>Nostr / NIP-05</strong> e integrazioni Bitcoin/Lightning con <strong>Breez SDK</strong> e <strong>NWC</strong>.',
        'Migliorate affidabilità e manutenibilità tramite refactoring, <strong>Biome</strong>, <strong>Jest</strong> e <strong>Maestro E2E</strong>, contribuendo ai layer mobile, protocollo e backend di supporto.',
      ],
    },
    {
      title: 'Frontend Developer',
      sub: 'Enhancers · Tinexta Group · Torino, Italia (Remoto)',
      meta: 'Ago 2023 – Lug 2024',
      bullets: [
        'Sviluppate funzionalità frontend in produzione per la <strong>piattaforma Angular di gestione dispositivi IoT</strong> di Tecnoalarm e il <strong>portale clienti React</strong> di Illumia, traducendo le <strong>specifiche Figma</strong> in interfacce responsive e integrando le API backend.',
        'Collaborato con i team backend sulle <strong>integrazioni dati IoT</strong> e migliorata la responsiveness applicativa tramite <strong>ottimizzazione delle performance a livello di componente</strong> e aderenza alle <strong>linee guida del design system</strong> condiviso.',
      ],
    },
    {
      title: 'Frontend / Full-Stack Developer',
      sub: 'Entiende SRL · Napoli, Italia (Remoto)',
      meta: 'Gen 2023 – Ago 2023',
      bullets: [
        'Realizzate <strong>landing page responsive</strong> per campagne TIM, funzionalità per il <strong>CRM backoffice Angular</strong> e manutenzione del sito aziendale.',
        'Progettato un sistema di notifiche real-time con <strong>NestJS</strong> e <strong>Socket.io</strong>, collegando backend Express.js e frontend Angular e implementando il tracking delle conversioni/lead in tempo reale.',
      ],
    },
  ],
  projectsTitle: 'Progetti',
  projects: [
    {
      name: 'BlurKit',
      links: [
        { label: 'GitHub', href: 'https://github.com/Okazakee/blurkit' },
        { label: 'Sito', href: 'https://blurkit.okazakee.dev/' },
        { label: 'npm', href: 'https://www.npmjs.com/package/blurkit' },
      ],
      stack: 'TypeScript · pnpm · turbo · tsup · sharp · BlurHash / ThumbHash',
      bullets: [
        '<strong>Libreria universale per placeholder di immagini</strong> pubblicata su <strong>npm</strong>, capace di generare placeholder blurhash/thumbhash per Node, Bun, Deno, browser, edge, Cloudflare e runtime WASM tramite una singola <strong>API unificata</strong>.',
        'Realizzata come <strong>pacchetto multi-runtime</strong> con entrypoint espliciti per ogni runtime, <strong>CLI</strong> per singole immagini e manifest di cartelle, e helper di cache per Node e Cloudflare.',
      ],
    },
    {
      name: 'MinePanel',
      links: [
        { label: 'GitHub', href: 'https://github.com/MinePanelProject' },
        { label: 'Sito', href: 'https://minepanel.xyz' },
      ],
      stack:
        'NestJS · Bun · PostgreSQL · Docker · GitHub Actions · React · Svelte',
      bullets: [
        'Sviluppo di una <strong>piattaforma self-hosted per la gestione di server Minecraft</strong> con backend NestJS/Bun testato, flussi di autenticazione e autorizzazione, migrazioni PostgreSQL e deployment basato su Docker.',
        'Realizzati <strong>workflow CI/CD e di rilascio container</strong> con controlli su migrazioni, E2E, image smoke, vulnerabilità, trusted Docker e pubblicazione multi-architettura.',
      ],
    },
    {
      name: 'PearLift',
      links: [
        { label: 'GitHub', href: 'https://github.com/Okazakee/PearLift' },
        { label: 'Sito', href: 'https://pearlift.okazakee.dev/' },
      ],
      stack:
        'React Native · Expo · TypeScript · SQLite · Holepunch / Pear · Maestro',
      bullets: [
        'Realizzato un <strong>workout tracker local-first</strong> senza account o backend centralizzato, con dati salvati in SQLite e sincronizzazione diretta <strong>peer-to-peer</strong> tra dispositivi tramite Holepunch.',
        'Implementati programmi multi-giorno, timer di recupero in background, backup/trasferimento via QR e test E2E con <strong>Maestro</strong>.',
      ],
    },
    {
      name: 'PreCall',
      links: [
        { label: 'GitHub', href: 'https://github.com/Okazakee/PreCall' },
        { label: 'npm', href: 'https://www.npmjs.com/package/precall' },
      ],
      stack: 'TypeScript · Bun · Zod · LangChain · Resend · npm',
      bullets: [
        "Realizzata e pubblicata una <strong>libreria TypeScript provider-neutral</strong> per trasformare richieste cliente strutturate in brief pre-call assistiti dall'AI, con integrazioni <strong>pluggabili AIAdapter ed EmailTransport</strong>.",
        "Definiti <strong>confini espliciti di privacy e affidabilità</strong> con <strong>permessi AI/output per singolo campo</strong>, <strong>validazione strict dello schema</strong>, submissions preservate e <strong>fallback graceful</strong> in caso di errore dell'AI o del delivery.",
      ],
    },
    {
      name: 'Okazakee-WS CMS',
      links: [
        {
          label: 'GitHub',
          href: 'https://github.com/Okazakee/okazakee-cms',
        },
      ],
      stack: 'Next.js 16 · TypeScript · Supabase · WebAuthn · Vitest · BlurKit',
      bullets: [
        "Realizzata un'<strong>applicazione content-management standalone</strong> per okazakee.dev con contenuti multilingua, pubblicazione portfolio/blog, preview, upload e storage condiviso su Supabase.",
        'Implementati <strong>GitHub OAuth + passkey WebAuthn</strong>, <strong>RBAC server-enforced</strong>, image processing sicura con <strong>BlurKit</strong> e <strong>invalidazione cache con firma HMAC</strong> tra CMS e sito pubblico.',
      ],
    },
  ],
  educationTitle: 'Istruzione',
  education: [
    {
      degree: 'Corso di Sviluppo Next.js',
      school: 'Udemy',
      year: '2022',
    },
    { degree: 'Corso Web Developer', school: 'Udemy', year: '2021' },
    {
      degree: 'Istituto Tecnico Commerciale',
      school: 'ITC G.B. Ferrigno · Castelvetrano, Italia',
      year: '2013 – 2018',
    },
  ],
  languagesTitle: 'Lingue',
  languages: [
    { name: 'Italiano', level: 'Madrelingua' },
    { name: 'Inglese', level: 'C1 – Padronanza tecnica' },
  ],
};
