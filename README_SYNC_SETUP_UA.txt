WOT PLATOON CUP — СИНХРОННЕ КОЛЕСО ДЛЯ КІЛЬКОХ СТРІМЕРІВ
=======================================================

ГОТОВІ ПОСИЛАННЯ ПІСЛЯ ЗАВАНТАЖЕННЯ НА GITHUB
---------------------------------------------
Для OBS усіх стрімерів:
https://saxonua.github.io/bsk/?room=main

Для керування колесом тільки у головного стрімера:
https://saxonua.github.io/bsk/control.html?room=main

ВАЖЛИВО
-------
GitHub Pages показує HTML-сторінку, а Firebase Realtime Database передає стан колеса між усіма OBS у реальному часі.
Google Sheets залишається джерелом списків і журналом сформованих взводів.

КРОК 1. СТВОРИ ПРОЄКТ FIREBASE
-------------------------------
1. Відкрий https://console.firebase.google.com/
2. Натисни Create a project.
3. Назва, наприклад: saxonua-bsk-wheel
4. Google Analytics можна вимкнути.

КРОК 2. СТВОРИ REALTIME DATABASE
--------------------------------
1. У меню Firebase відкрий Build → Realtime Database.
2. Натисни Create Database.
3. Обери найближчий регіон.
4. Для першого запуску обери Test mode.
5. Після перевірки обов'язково встанови захищені правила з кроку 6.

КРОК 3. УВІМКНИ АНОНІМНИЙ ВХІД ДЛЯ ГОЛОВНОГО БРАУЗЕРА
----------------------------------------------------
1. Відкрий Build → Authentication.
2. Натисни Get started.
3. Вкладка Sign-in method.
4. Увімкни Anonymous.

КРОК 4. ДОДАЙ WEB APP ТА ВСТАВ КОНФІГУРАЦІЮ
-------------------------------------------
1. Firebase → Project settings → General.
2. Унизу натисни значок Web: </>
3. Назва, наприклад: bsk-wheel-web
4. Firebase Hosting вмикати не потрібно.
5. Після створення Firebase покаже firebaseConfig.
6. Відкрий файл firebase-config.js.
7. Заміни тестові значення PASTE_... на значення зі свого firebaseConfig.
8. Переконайся, що у конфігурації є databaseURL. Його також видно у Build → Realtime Database.

КРОК 5. ЗАВАНТАЖ ФАЙЛИ НА GITHUB
--------------------------------
Заміни файли у репозиторії bsk вмістом цієї папки.
Головні нові файли:
- index.html
- control.html
- sync-wheel.js
- firebase-config.js
- firebase-rules.json

Папку Images та інші старі файли можна залишити.
Після завантаження відкрий:
https://saxonua.github.io/bsk/control.html?room=main

КРОК 6. ЗАХИСТИ КЕРУВАННЯ КОЛЕСОМ
---------------------------------
1. На сторінці керування знайди блок «Синхронізація».
2. Скопіюй UID головного браузера кнопкою «КОПІЮВАТИ UID».
3. Відкрий файл firebase-rules.json.
4. Заміни PASTE_CONTROLLER_UID_HERE на скопійований UID.
5. У Firebase відкрий Build → Realtime Database → Rules.
6. Встав увесь вміст firebase-rules.json.
7. Натисни Publish.

Після цього дивитися колесо може будь-хто за OBS-посиланням, а змінювати стан — лише головний браузер з цим UID.

КРОК 7. ДОДАЙ ПОСИЛАННЯ В OBS
-----------------------------
У кожного стрімера:
1. Sources → + → Browser.
2. URL:
   https://saxonua.github.io/bsk/?room=main
3. Рекомендований розмір: 1920 × 1080.
4. Увімкни «Refresh browser when scene becomes active», якщо OBS іноді довго не використовує сцену.

КЕРУВАННЯ
---------
Крутити колесо, перемикати тури, створювати новий взвод, повертати гравця та скидати стан потрібно лише через:
https://saxonua.github.io/bsk/control.html?room=main

ДОДАТКОВІ КІМНАТИ
-----------------
Для іншого турніру можна використати іншу назву кімнати:
https://saxonua.github.io/bsk/?room=test
https://saxonua.github.io/bsk/control.html?room=test

ЗАПИС У GOOGLE SHEETS
---------------------
Як і раніше, один раз натисни «НАЛАШТУВАТИ ЗАПИС» у сторінці керування та встав URL Google Apps Script, який закінчується на /exec.
URL зберігається лише у браузері головного стрімера.
