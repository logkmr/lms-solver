// ==UserScript==
// @name         LMS Quiz Assistant
// @namespace    http://tampermonkey.net/
// @version      1.7
// @description  Отправляет вопросы теста в ChatGPT и автоматически выбирает ответы
// @author       You
// @match        https://lms.mitu.msk.ru/mod/quiz/attempt.php*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        GM_xmlhttpRequest
// @connect      api.aitunnel.ru
// @connect      lms.mitu.msk.ru
// @require      https://cdn.jsdelivr.net/npm/marked@4.0.0/marked.min.js
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Конфигурация
    const config = {
        apiKey: 'sk-aitunnel-...',
        baseUrl: 'https://api.aitunnel.ru/v1/',
        model: 'gemini-2.5-flash-lite',
        temperature: 0.7,
        maxRetries: 2,
        timeout: 15000
    };

    // Кэш для хранения загруженного контекста
    let contextCache = null;

    // Проверяем, что это страница попытки теста
    function isQuizAttemptPage() {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.has('attempt') && urlParams.has('cmid');
    }

    // Получаем ссылку на предыдущую активность
    function getPrevActivityLink() {
        const prevActivityLink = document.getElementById('prev-activity-link');
        return prevActivityLink ? prevActivityLink.href : null;
    }

    // Загружаем контекст из предыдущей активности
    // Загружаем контекст из предыдущей активности
function loadContextFromPrevActivity(callback) {
    const prevActivityLink = getPrevActivityLink();

    if (!prevActivityLink) {
        console.log('Ссылка на предыдущую активность не найдена');
        callback(null);
        return;
    }

    // Если контекст уже загружен, используем кэш
    if (contextCache) {
        callback(contextCache);
        return;
    }

    console.log('Загружаем контекст из:', prevActivityLink);

    GM_xmlhttpRequest({
        method: 'GET',
        url: prevActivityLink,
        onload: function(response) {
            try {
                // Создаем временный DOM для парсинга HTML
                const parser = new DOMParser();
                const doc = parser.parseFromString(response.responseText, 'text/html');

                // Ищем основной контент страницы - разные варианты для разных типов страниц
                let content = null;

                // Для страниц лекций (Page)
                content = doc.querySelector('.main-content .no-overflow, .activity-inner, [role="main"] .no-overflow');

                // Если не нашли, ищем по другим селекторам
                if (!content) {
                    content = doc.querySelector('.main-content, .activity-inner, [role="main"], .content');
                }

                // Если все еще не нашли, используем body как запасной вариант
                if (!content) {
                    content = doc.querySelector('body');
                }

                let contextText = '';
                if (content) {
                    // Извлекаем текстовый контент, убираем лишние пробелы и HTML теги
                    contextText = content.textContent
                        .replace(/<[^>]*>/g, ' ') // Убираем HTML теги
                        .replace(/\s+/g, ' ') // Заменяем множественные пробелы на один
                        .trim()
                        .substring(0, 8000); // Ограничиваем длину для избежания переполнения

                    // Убираем лишний текст (навигацию, заголовки и т.д.)
                    contextText = contextText
                        .replace(/Перейти на\.\.\./g, '')
                        .replace(/Личный кабинет/g, '')
                        .replace(/Курсы/g, '')
                        .replace(/Главная страница курса/g, '')
                        .replace(/Найти/g, '')
                        .replace(/Расписание вебинаров/g, '')
                        .replace(/Личные файлы/g, '')
                        .replace(/\s+/g, ' ')
                        .trim();
                }

                if (contextText.length > 100) { // Минимальная длина контекста
                    contextCache = contextText;
                    console.log('Контекст успешно загружен, длина:', contextText.length);
                    console.log('Первые 500 символов контекста:', contextText.substring(0, 500));
                    callback(contextText);
                } else {
                    console.log('Не удалось извлечь контекст из страницы. Длина текста:', contextText.length);
                    console.log('URL страницы:', prevActivityLink);
                    callback(null);
                }
            } catch (error) {
                console.error('Ошибка при парсинге контекста:', error);
                callback(null);
            }
        },
        onerror: function(error) {
            console.error('Ошибка при загрузке контекста:', error);
            callback(null);
        },
        ontimeout: function() {
            console.error('Таймаут при загрузке контекста');
            callback(null);
        }
    });
}

    function extractQuestionData() {
        const questionData = [];
        const questions = document.querySelectorAll('.formulation.clearfix');

        questions.forEach((question, index) => {
            const questionObj = {
                number: index + 1,
                text: '',
                answers: [],
                multipleAnswers: false,
                questionElement: question
            };

            // Извлекаем текст вопроса
            const qtext = question.querySelector('.qtext .clearfix');
            if (qtext) {
                questionObj.text = qtext.textContent.trim();
            }

            // Проверяем тип вопроса (один или несколько вариантов)
            const answerBlocks = question.querySelectorAll('.answer > div[class^="r"]');
            answerBlocks.forEach(answerBlock => {
                const input = answerBlock.querySelector('input[type="radio"], input[type="checkbox"], input[type="hidden"]');

                // Определяем тип вопроса
                if (input) {
                    if (input.type === 'checkbox' || (input.type === 'hidden' &&
                        answerBlock.querySelector('input[type="checkbox"]'))) {
                        questionObj.multipleAnswers = true;
                    }
                }

                const answerText = answerBlock.querySelector('.flex-fill.ms-1');
                const answerNumber = answerBlock.querySelector('.answernumber');

                if (answerText) {
                    const letter = answerNumber ? answerNumber.textContent.trim().replace('.', '') : '';
                    questionObj.answers.push({
                        letter: letter,
                        text: answerText.textContent.trim(),
                        value: answerBlock.querySelector('input') ? answerBlock.querySelector('input').value : '',
                        inputElement: answerBlock.querySelector('input'),
                        answerElement: answerBlock
                    });
                }
            });

            questionData.push(questionObj);
        });

        return questionData;
    }

    function buildPrompt(questionData, context = null) {
        let prompt = `Проанализируй вопрос теста и предложи правильный ответ. `;

        // Добавляем контекст если он есть
        if (context) {
            prompt += `У тебя есть следующий контекст из учебного материала:\n\n${context}\n\n`;
            prompt += `Используй этот контекст для более точного определения правильного ответа. `;
        }

        prompt += `Верни ТОЛЬКО буквы правильных ответов в формате: "a" или "a, b, c" (через запятую, если несколько). `;
        prompt += `Не добавляй никаких других комментариев или текста.`;

        questionData.forEach(question => {
            prompt += `\n\nВопрос: ${question.text}`;
            prompt += `\nТип вопроса: ${question.multipleAnswers ? 'Выберите ВСЕ правильные варианты' : 'Выберите ОДИН правильный вариант'}`;
            prompt += `\nВарианты ответа:`;

            question.answers.forEach(answer => {
                prompt += `\n${answer.letter}) ${answer.text}`;
            });
        });

        return prompt;
    }

    // Парсим ответ ИИ и извлекаем буквы ответов
    function parseAIResponse(response) {
        // Очищаем ответ от лишнего текста и извлекаем только буквы
        const cleanResponse = response.trim();

        // Ищем паттерны типа "a", "a, b", "a,b,c" и т.д.
        const match = cleanResponse.match(/([a-zA-Z])(?:\s*,\s*([a-zA-Z]))*/);

        if (!match) return [];

        // Разделяем буквы по запятым и убираем пробелы
        const letters = cleanResponse.split(',').map(letter => letter.trim().toUpperCase());

        return letters;
    }

    // Подсвечиваем и выбираем правильные ответы
    function highlightAndSelectAnswers(questionData, answerLetters) {
        questionData.forEach((question, index) => {
            const letters = answerLetters[index] || [];

            question.answers.forEach(answer => {
                // Сбрасываем предыдущее выделение и удаляем метки
                if (answer.answerElement) {
                    answer.answerElement.style.backgroundColor = '';
                    answer.answerElement.style.border = '';

                    // Удаляем существующие метки
                    const existingLabels = answer.answerElement.querySelectorAll('.correct-label');
                    existingLabels.forEach(label => label.remove());
                }

                // Если это правильный ответ - подсвечиваем
                if (letters.includes(answer.letter.toUpperCase())) {
                    if (answer.answerElement) {
                        answer.answerElement.style.backgroundColor = '#d4edda';
                        answer.answerElement.style.border = '2px solid #28a745';
                        answer.answerElement.style.borderRadius = '5px';
                        answer.answerElement.style.padding = '5px';

                        // Добавляем текст в зеленой рамке
                        const correctLabel = document.createElement('div');
                        correctLabel.textContent = 'ChatGPT считает этот ответ правильным';
                        correctLabel.style.marginLeft = 'auto';
                        correctLabel.style.padding = '2px 5px';
                        correctLabel.style.color = 'green';
                        correctLabel.classList.add('correct-label');
                        answer.answerElement.appendChild(correctLabel);
                    }

                    // Автоматически выбираем ответ
                    if (answer.inputElement) {
                        if (answer.inputElement.type === 'checkbox' || answer.inputElement.type === 'radio') {
                            answer.inputElement.checked = true;
                        } else if (answer.inputElement.type === 'hidden') {
                            // Для скрытых полей (обычно это checkbox'ы в Moodle)
                            const realCheckbox = answer.answerElement.querySelector('input[type="checkbox"]');
                            if (realCheckbox) {
                                realCheckbox.checked = true;
                            }
                        }

                        // Триггерим события изменения для обновления состояния формы
                        const event = new Event('change', { bubbles: true });
                        if (answer.inputElement) answer.inputElement.dispatchEvent(event);
                    }
                }
            });
        });
    }

    // Отправляем запрос к ChatGPT с повторными попытками
    function askChatGPT(prompt, callback, retryCount = 0) {
        showLoadingIndicator(retryCount);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), config.timeout);

        GM_xmlhttpRequest({
            method: 'POST',
            url: config.baseUrl + '/chat/completions',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`
            },
            data: JSON.stringify({
                model: config.model,
                messages: [{role: 'user', content: prompt}],
                temperature: config.temperature
            }),
            timeout: config.timeout,
            onload: function(response) {
                clearTimeout(timeoutId);
                try {
                    const data = JSON.parse(response.responseText);

                    if (data && data.choices && data.choices.length > 0 &&
                        data.choices[0].message && data.choices[0].message.content) {
                        callback(null, data.choices[0].message.content);
                    } else {
                        throw new Error('Неверный формат ответа от API');
                    }
                } catch (error) {
                    // Пробуем повторить при ошибках парсинга
                    if (retryCount < config.maxRetries) {
                        console.log(`Попытка ${retryCount + 1} не удалась, пробуем еще раз...`);
                        setTimeout(() => {
                            askChatGPT(prompt, callback, retryCount + 1);
                        }, 2000);
                    } else {
                        callback(new Error('Ошибка парсинга ответа: ' + error.message), null);
                    }
                }
            },
            onerror: function(error) {
                clearTimeout(timeoutId);

                // Пробуем повторить при ошибках сети/сервера
                if (retryCount < config.maxRetries) {
                    console.log(`Ошибка на попытке ${retryCount + 1}, пробуем еще раз...`, error);
                    setTimeout(() => {
                        askChatGPT(prompt, callback, retryCount + 1);
                    }, 2000);
                } else {
                    callback(new Error(`Не удалось получить ответ после ${config.maxRetries + 1} попыток: ${error.message}. Попробуйте снова или проверьте интернет соединение.`), null);
                }
            },
            ontimeout: function() {
                clearTimeout(timeoutId);

                // Пробуем повторить при таймауте
                if (retryCount < config.maxRetries) {
                    console.log(`Таймаут на попытке ${retryCount + 1}, пробуем еще раз...`);
                    setTimeout(() => {
                        askChatGPT(prompt, callback, retryCount + 1);
                    }, 2000);
                } else {
                    callback(new Error(`Таймаут после ${config.maxRetries + 1} попыток`), null);
                }
            }
        });
    }

    // Показываем индикатор загрузки с счетчиком попыток
    function showLoadingIndicator(retryCount = 0, loadingContext = false) {
        const loaderId = 'lms-chatgpt-loader';
        const existingLoader = document.getElementById(loaderId);

        if (existingLoader) {
            const attemptText = existingLoader.querySelector('.attempt-text');
            if (attemptText) {
                let text = '';
                if (loadingContext) {
                    text = 'Загружаем учебный материал...';
                } else {
                    text = retryCount > 0 ?
                        `Попытка ${retryCount + 1} из ${config.maxRetries + 1}...` :
                        'Нейросеть думает над ответом...';
                }
                attemptText.textContent = text;
            }
            return;
        }

        const loaderHtml = `
            <div id="${loaderId}" style="
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: white;
                padding: 20px;
                border-radius: 5px;
                box-shadow: 0 0 10px rgba(0,0,0,0.2);
                z-index: 9999;
                display: flex;
                flex-direction: column;
                align-items: center;
            ">
                <div style="width: 50px; height: 50px; border: 5px solid #f3f3f3; border-top: 5px solid #3498db; border-radius: 50%; animation: spin 1s linear infinite;"></div>
                <p class="attempt-text" style="margin-top: 15px; text-align: center;">
                    ${loadingContext ? 'Загружаем учебный материал...' :
                      (retryCount > 0 ? `Попытка ${retryCount + 1} из ${config.maxRetries + 1}...` : 'Нейросеть думает над ответом...')}
                </p>
                <button id="cancel-request" style="margin-top: 10px; padding: 5px 10px; background: #ff4757; color: white; border: none; border-radius: 3px; cursor: pointer;">
                    Отмена
                </button>
            </div>
            <style>
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
            </style>
        `;

        document.body.insertAdjacentHTML('beforeend', loaderHtml);

        document.getElementById('cancel-request').addEventListener('click', () => {
            hideLoadingIndicator();
        });
    }

    // Убираем индикатор загрузки
    function hideLoadingIndicator() {
        const loader = document.getElementById('lms-chatgpt-loader');
        if (loader) loader.remove();
    }

    // Функция для открытия вопроса в yandex
    function openInyandex(questionData) {
        if (questionData.length === 0) return;

        let searchText = '';

        questionData.forEach(question => {
            searchText += `${question.text} `;
            searchText += `${question.multipleAnswers ? '(Вариантов ответа минимум 2): ' : ''} `;
            searchText += '';

            question.answers.forEach(answer => {
                searchText += `${answer.letter}) ${answer.text} `;
            });

            searchText += ' ';
        });

        const encodedSearchText = encodeURIComponent(searchText.trim());
        const yandexUrl = `https://yandex.ru/search/?text=${encodedSearchText}`;
        window.open(yandexUrl, '_blank');
    }

    // Основная функция для обработки запроса к ChatGPT с контекстом
    function processWithContext() {
        const questionData = extractQuestionData();
        if (questionData.length === 0) {
            alert('Не удалось найти вопросы на странице');
            return;
        }

        // Показываем индикатор загрузки контекста
        showLoadingIndicator(0, true);

        // Сначала загружаем контекст, затем отправляем запрос к GPT
        loadContextFromPrevActivity(function(context) {
            hideLoadingIndicator();

            showLoadingIndicator();
            const prompt = buildPrompt(questionData, context);

            askChatGPT(prompt, (error, response) => {
                hideLoadingIndicator();

                if (error) {
                    alert('Ошибка при запросе к ChatGPT: ' + error.message);
                    return;
                }

                const answerLetters = parseAIResponse(response);
                highlightAndSelectAnswers(questionData, [answerLetters]);

                if (context) {
                    console.log('Запрос выполнен с использованием учебного контекста');
                }
            });
        });
    }

    // Добавляем кнопки для запроса к ChatGPT и yandex поиска
    function addChatGPTButton() {
        const buttonContainerId = 'ai-assistant-buttons';
        if (document.getElementById(buttonContainerId)) return;

        const container = document.createElement('div');
        container.id = buttonContainerId;
        container.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 999999999;
            display: flex;
            gap: 10px;
            align-items: center;
        `;

        // Кнопка yandex
        const yandexButton = document.createElement('button');
        yandexButton.innerHTML = `
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M2.04 12c0-5.523 4.476-10 10-10 5.522 0 10 4.477 10 10s-4.478 10-10 10c-5.524 0-10-4.477-10-10z" fill="#FC3F1D"/>
                <path d="M13.32 7.666h-.924c-1.694 0-2.585.858-2.585 2.123 0 1.43.616 2.1 1.881 2.959l1.045.704-3.003 4.487H7.49l2.695-4.014c-1.55-1.111-2.42-2.19-2.42-4.015 0-2.288 1.595-3.85 4.62-3.85h3.003v11.868H13.32V7.666z" fill="#fff"/>
            </svg>
        `;

        Object.assign(yandexButton.style, {
            width: '50px',
            height: '50px',
            padding: '0',
            backgroundColor: '#FC3F1D',
            border: 'none',
            borderRadius: '5px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
        });

        const yandexSvg = yandexButton.querySelector('svg');
        yandexSvg.style.cssText = `
            display: block;
            margin: auto;
        `;

        // Кнопка ChatGPT
        const chatGPTButton = document.createElement('button');
        chatGPTButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 5px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg> Спросить ChatGPT';

        Object.assign(chatGPTButton.style, {
            padding: '10px 15px',
            backgroundColor: '#10a37f',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            cursor: 'pointer',
            fontWeight: 'bold',
            boxShadow: '0 2px 5px rgba(0,0,0,0.2)',
            display: 'flex',
            alignItems: 'center'
        });

        // Обработчики событий
        yandexButton.addEventListener('click', () => {
            const questionData = extractQuestionData();
            if (questionData.length === 0) {
                alert('Не удалось найти вопросы на странице');
                return;
            }
            openInyandex(questionData);
        });

        chatGPTButton.addEventListener('click', processWithContext);

        // Добавляем кнопки в контейнер
        container.appendChild(yandexButton);
        container.appendChild(chatGPTButton);
        document.body.appendChild(container);
    }

    // Инициализация
    function init() {
        if (isQuizAttemptPage()) {
            setTimeout(addChatGPTButton, 100);
        }
    }

    // Запускаем после загрузки страницы
    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init);
    }
})();
