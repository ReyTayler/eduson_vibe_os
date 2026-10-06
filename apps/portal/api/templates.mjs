export default {
  web: {
    "index.html":
      '<!doctype html>\n<html lang="ru">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width,initial-scale=1" />\n    <title>Моя первая идея</title>\n    <link rel="stylesheet" href="./style.css" />\n  </head>\n  <body>\n    <main class="card">\n      <span class="tag">МОЙ НОВЫЙ ПРОЕКТ</span>\n      <h1>Большие идеи<br />начинаются с малого.</h1>\n      <p>\n        Это твоё пространство. Поменяй текст, добавь любимые цвета и создай то,\n        чего ещё не было.\n      </p>\n      <button id="idea">Добавить немного вдохновения ↗</button>\n      <div id="note">Сделай первый шаг сегодня.</div>\n      <footer>Создано мной · Vibe OS</footer>\n    </main>\n    <script src="./app.js"></script>\n  </body>\n</html>\n',
    "style.css":
      "* {\n  box-sizing: border-box;\n}\nbody {\n  margin: 0;\n  min-height: 100vh;\n  display: grid;\n  place-items: center;\n  padding: 24px;\n  font-family: system-ui;\n  color: #173b61;\n  background:\n    radial-gradient(at 20% 10%, #d4f1ff, transparent 65%),\n    linear-gradient(130deg, #edf8ff, #e0eaff);\n}\n.card {\n  max-width: 660px;\n  padding: 64px;\n  background: #ffffffb8;\n  border: 1px solid white;\n  box-shadow: 0 28px 80px #28689a17;\n  border-radius: 36px;\n  backdrop-filter: blur(24px);\n}\n.tag {\n  font-size: 11px;\n  letter-spacing: 0.2em;\n  color: #3994c9;\n}\nh1 {\n  font-size: clamp(32px, 6vw, 54px);\n  letter-spacing: -0.055em;\n  line-height: 1.12;\n}\np {\n  line-height: 1.7;\n  color: #63809a;\n}\nbutton {\n  border: 0;\n  border-radius: 14px;\n  padding: 17px 22px;\n  background: #248fcf;\n  color: white;\n  font: 600 14px system-ui;\n  cursor: pointer;\n  box-shadow: 0 8px 24px #258fce30;\n}\nbutton:hover {\n  background: #147ebd;\n}\n#note {\n  min-height: 28px;\n  margin: 24px 0;\n  color: #3077a6;\n}\nfooter {\n  margin-top: 40px;\n  color: #90a7ba;\n  font-size: 12px;\n}\n",
    "app.js":
      "const ideas = [\n  'Создай сайт о том, что любишь.',\n  'Попробуй добавить движение.',\n  'Пусть твой проект поможет другу.',\n  'Одна маленькая функция — уже начало.',\n];\nlet index = 0;\ndocument.querySelector('#idea').addEventListener('click', () => {\n  document.querySelector('#note').textContent = ideas[index++ % ideas.length];\n});\n",
    "README.md":
      "# Моя первая идея\n\nВеб-проект на HTML, CSS и JavaScript.\n\nОткрой index.html, измени текст и нажми «Сохранить». Нажми «Предпросмотр», чтобы увидеть результат. «Включить хостинг» публикует сохранённую версию проекта.\n",
  },
  python: {
    "main.py":
      'def greet(name):\n    return f"Привет, {name}! Твой первый Python-проект работает."\n\n\nprint(greet("исследователь"))\n\nfor number in range(1, 6):\n    print(f"Шаг {number}: пробуй, меняй, создавай.")\n',
    "README.md":
      "# Мои первые шаги в Python\n\nОткрой main.py, измени программу и нажми «Запустить».\n",
  },
  node: {
    "main.js":
      "const name = 'исследователь';\nconsole.log('Привет, ' + name + '! Node-проект работает.');\nfor (let step = 1; step <= 5; step++)\n  console.log('Шаг ' + step + ': пробуй, меняй, создавай.');\n",
    "README.md": "# Мой Node-проект\n\nОткрой main.js и нажми «Запустить».\n",
  },
};
