export interface Lesson {
  number: number;
  title: string;
  module: number;
  moduleTitle: string;
  slides: number;
  source: string;
  sourceSha256: string;
  cover: string;
  cover2x: string;
}

export const lessons: Lesson[] = [
  {
    number: 1,
    title: "Установка инструментов и первая веб-страница",
    module: 1,
    moduleTitle: "Первые сайты в браузере",
    slides: 22,
    source:
      "https://terenta.github.io/eduson-kids-design-book/lessons/urok_1.html",
    sourceSha256:
      "60cf3cca81f0733056885e06aa496bb46fe1b8465b703151b56f0e4bf14c8184",
    cover: "/lessons/lesson-01-60cf3cca81-384.webp",
    cover2x: "/lessons/lesson-01-60cf3cca81-768.webp",
  },
  {
    number: 2,
    title: "Сайт из трёх файлов и техники работы с AI",
    module: 1,
    moduleTitle: "Первые сайты в браузере",
    slides: 22,
    source:
      "https://terenta.github.io/eduson-kids-design-book/lessons/urok_2.html",
    sourceSha256:
      "b1ac8ff0a769c3562ae3e6bf96b192e28aabb1f20b7fd6f8e6cfe6bee7286aeb",
    cover: "/lessons/lesson-02-b1ac8ff0a7-384.webp",
    cover2x: "/lessons/lesson-02-b1ac8ff0a7-768.webp",
  },
  {
    number: 3,
    title: "Интерактивность: события и DOM",
    module: 1,
    moduleTitle: "Первые сайты в браузере",
    slides: 38,
    source:
      "https://terenta.github.io/eduson-kids-design-book/lessons/urok_3.html",
    sourceSha256:
      "5e8f7959f51baddc65137077d84b123ee1d1d7f41d87328842ff4e9e343e00de",
    cover: "/lessons/lesson-03-5e8f7959f5-384.webp",
    cover2x: "/lessons/lesson-03-5e8f7959f5-768.webp",
  },
  {
    number: 4,
    title: "Своя браузерная игра на Canvas",
    module: 1,
    moduleTitle: "Первые сайты в браузере",
    slides: 38,
    source:
      "https://terenta.github.io/eduson-kids-design-book/lessons/urok_4.html",
    sourceSha256:
      "f23ca5ad6f148fefbec3d0b441898c2a84546f3462c13555920d2c8b3962be79",
    cover: "/lessons/lesson-04-f23ca5ad6f-384.webp",
    cover2x: "/lessons/lesson-04-f23ca5ad6f-768.webp",
  },
  {
    number: 5,
    title: "Первая программа на Python с AI",
    module: 2,
    moduleTitle: "Программы на Python с нейросетью",
    slides: 38,
    source:
      "https://terenta.github.io/eduson-kids-design-book/lessons/urok_5.html",
    sourceSha256:
      "d7e49680e112d5dcf33d5c326d291b49dbc0c4897c7543e3ddf3bd6d3603315d",
    cover: "/lessons/lesson-05-d7e49680e1-384.webp",
    cover2x: "/lessons/lesson-05-d7e49680e1-768.webp",
  },
  {
    number: 6,
    title: "Циклы, функции и коллекции",
    module: 2,
    moduleTitle: "Программы на Python с нейросетью",
    slides: 38,
    source:
      "https://terenta.github.io/eduson-kids-design-book/lessons/urok_6.html",
    sourceSha256:
      "bfc84ef67bb8aab2fd6695b4494141808a580e2c1191b13d70b205f8c1909380",
    cover: "/lessons/lesson-06-bfc84ef67b-384.webp",
    cover2x: "/lessons/lesson-06-bfc84ef67b-768.webp",
  },
  {
    number: 7,
    title: "Работа с файлами и формат JSON",
    module: 2,
    moduleTitle: "Программы на Python с нейросетью",
    slides: 38,
    source:
      "https://terenta.github.io/eduson-kids-design-book/lessons/urok_7.html",
    sourceSha256:
      "28d2b383c458fde089892e34fbd79f535d2f11413d540cdfdfe787ebfb785830",
    cover: "/lessons/lesson-07-28d2b383c4-384.webp",
    cover2x: "/lessons/lesson-07-28d2b383c4-768.webp",
  },
  {
    number: 8,
    title: "Работа с внешними API",
    module: 2,
    moduleTitle: "Программы на Python с нейросетью",
    slides: 38,
    source:
      "https://terenta.github.io/eduson-kids-design-book/lessons/urok_8.html",
    sourceSha256:
      "68ef18ec4ef7bf9fadd473fe87eedf42718fc03b1e6bbdf137853c4f30f399e0",
    cover: "/lessons/lesson-08-68ef18ec4e-384.webp",
    cover2x: "/lessons/lesson-08-68ef18ec4e-768.webp",
  },
  {
    number: 9,
    title: "Telegram-бот с языковой моделью",
    module: 3,
    moduleTitle: "AI-приложения с публичной ссылкой",
    slides: 38,
    source:
      "https://terenta.github.io/eduson-kids-design-book/lessons/urok_9.html",
    sourceSha256:
      "424b8e282c9a59b9f809ff495970290017f4200788c0d88df45955f3b04df884",
    cover: "/lessons/lesson-09-424b8e282c-384.webp",
    cover2x: "/lessons/lesson-09-424b8e282c-768.webp",
  },
  {
    number: 10,
    title: "Своё веб-приложение в интернете",
    module: 3,
    moduleTitle: "AI-приложения с публичной ссылкой",
    slides: 38,
    source:
      "https://terenta.github.io/eduson-kids-design-book/lessons/urok_10.html",
    sourceSha256:
      "5858722a44493ba90dba765789e5d84d36875d6915b261782b278fb1b2c9d6ea",
    cover: "/lessons/lesson-10-5858722a44-384.webp",
    cover2x: "/lessons/lesson-10-5858722a44-768.webp",
  },
  {
    number: 11,
    title: "Как программы общаются с нейросетью",
    module: 4,
    moduleTitle: "Углублённо с нейросетями",
    slides: 38,
    source:
      "https://terenta.github.io/eduson-kids-design-book/lessons/urok_11.html",
    sourceSha256:
      "6481a7128e7e4301a1a28cf0f2e73319c6b7a94628c367f4f413a6d67593792e",
    cover: "/lessons/lesson-11-6481a7128e-384.webp",
    cover2x: "/lessons/lesson-11-6481a7128e-768.webp",
  },
  {
    number: 12,
    title: "Чат с AI, как в ChatGPT",
    module: 4,
    moduleTitle: "Углублённо с нейросетями",
    slides: 38,
    source:
      "https://terenta.github.io/eduson-kids-design-book/lessons/urok_12.html",
    sourceSha256:
      "33be00430164b053abf36a43394a86274ec7d8f31392c23465a8b8aefbb9eafb",
    cover: "/lessons/lesson-12-33be004301-384.webp",
    cover2x: "/lessons/lesson-12-33be004301-768.webp",
  },
  {
    number: 13,
    title: "Введение в базы данных",
    module: 5,
    moduleTitle: "Данные, сервисы и соцсеть класса",
    slides: 36,
    source:
      "https://terenta.github.io/eduson-kids-design-book/lessons/urok_13.html",
    sourceSha256:
      "3773204511397a8b35a7438e2d3d56056b734944bb2473aff0e60eca1a724be8",
    cover: "/lessons/lesson-13-3773204511-384.webp",
    cover2x: "/lessons/lesson-13-3773204511-768.webp",
  },
];
