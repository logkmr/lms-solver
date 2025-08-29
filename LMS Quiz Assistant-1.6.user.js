// ==UserScript==
// @name         LMS Quiz Assistant
// @namespace    http://tampermonkey.net/
// @version      1.6
// @description  Отправляет вопросы теста в ChatGPT и автоматически выбирает ответы
// @author       You
// @match        https://lms.mitu.msk.ru/mod/quiz/attempt.php*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        GM_xmlhttpRequest
// @connect      key.wenwen-ai.com
// @require      https://cdn.jsdelivr.net/npm/marked@4.0.0/marked.min.js
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Конфигурация
    const config = {
        apiKey: '',
        baseUrl: 'https://key.wenwen-ai.com/v1',
        model: 'gemini-2.5-flash',
        temperature: 0.7
    };

    // Проверяем, что это страница попытки теста
    function isQuizAttemptPage() {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.has('attempt') && urlParams.has('cmid');
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

    function buildPrompt(questionData) {
        let prompt = `Проанализируй вопрос теста и предложи правильный ответ. `;
        prompt += `Верни ТОЛЬКО буквы правильных ответов в формате: "a" или "a, b, c" (через запятую, если несколько). `;
        prompt += `Не добавляй никаких других комментариев или текста.`;

        questionData.forEach(question => {
            prompt += `\n\nВопрос ${question.number}: ${question.text}`;
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

    // Отправляем запрос к ChatGPT
    function askChatGPT(prompt, callback) {
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
            timeout: 15000,
            onload: function(response) {
                try {
                    const data = JSON.parse(response.responseText);

                    if (data && data.choices && data.choices.length > 0 &&
                        data.choices[0].message && data.choices[0].message.content) {
                        callback(null, data.choices[0].message.content);
                    } else {
                        callback(new Error('Неверный формат ответа от API'), null);
                    }
                } catch (error) {
                    callback(new Error('Ошибка парсинга ответа: ' + error.message), null);
                }
            },
            onerror: function(error) {
                callback(error, null);
            },
            ontimeout: function() {
                callback(new Error('Ошибка с соединением, попробуйте снова'), null);
            }
        });
    }

    // Показываем индикатор загрузки
    function showLoadingIndicator() {
        const loaderId = 'lms-chatgpt-loader';
        const existingLoader = document.getElementById(loaderId);
        if (existingLoader) return;

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
                <p style="margin-top: 15px;">Нейросеть думает над ответом...</p>
            </div>
            <style>
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
            </style>
        `;

        document.body.insertAdjacentHTML('beforeend', loaderHtml);
    }

    // Убираем индикатор загрузки
    function hideLoadingIndicator() {
        const loader = document.getElementById('lms-chatgpt-loader');
        if (loader) loader.remove();
    }

    // Добавляем кнопку для запроса к ChatGPT
    function addChatGPTButton() {
        const buttonId = 'ask-chatgpt-btn';
        if (document.getElementById(buttonId)) return;

        const button = document.createElement('button');
        button.id = buttonId;
        button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 5px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg> Спросить ChatGPT';

        Object.assign(button.style, {
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            zIndex: '999999999',
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

        button.addEventListener('click', () => {
            const questionData = extractQuestionData();
            if (questionData.length === 0) {
                alert('Не удалось найти вопросы на странице');
                return;
            }

            showLoadingIndicator();
            const prompt = buildPrompt(questionData);

            askChatGPT(prompt, (error, response) => {
                hideLoadingIndicator();

                if (error) {
                    alert('Ошибка при запросе к ChatGPT: ' + error.message);
                    return;
                }

                // Парсим ответ и автоматически выбираем ответы
                const answerLetters = parseAIResponse(response);
                highlightAndSelectAnswers(questionData, [answerLetters]); // Передаем как массив для совместимости
            });
        });

        document.body.appendChild(button);
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
