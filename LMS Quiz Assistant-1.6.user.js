// ==UserScript==
// @name         LMS Quiz Assistant
// @namespace    http://tampermonkey.net/
// @version      1.6
// @description  Отправляет вопросы теста в ChatGPT и получает ответы
// @author       You
// @match        https://lms.mitu.msk.ru/mod/quiz/attempt.php*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        GM_xmlhttpRequest
// @connect      api.aitunnel.ru
// @require      https://cdn.jsdelivr.net/npm/marked@4.0.0/marked.min.js
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Конфигурация
    const config = {
        apiKey: '', // Ваш API-ключ
        baseUrl: 'https://api.aitunnel.ru/v1/',
        model: 'gemini-flash-1.5-8b',
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
            multipleAnswers: false // По умолчанию предполагаем один вариант ответа
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
                questionObj.answers.push({
                    letter: answerNumber ? answerNumber.textContent.trim().replace('.', '') : '',
                    text: answerText.textContent.trim(),
                    value: answerBlock.querySelector('input') ? answerBlock.querySelector('input').value : ''
                });
            }
        });

        questionData.push(questionObj);
    });

    return questionData;
}

function buildPrompt(questionData) {
    let prompt = `Проанализируй вопрос теста и предложи правильный ответ. `;

    questionData.forEach(question => {
        prompt += `\n\nВопрос ${question.number}: ${question.text}`;
        prompt += `\nТип вопроса: ${question.multipleAnswers ? 'Выберите ВСЕ правильные варианты' : 'Выберите ОДИН правильный вариант'}`;
        prompt += `\nВарианты ответа:`;

        question.answers.forEach(answer => {
            prompt += `\n${answer.letter}) ${answer.text}`;
        });
    });

    prompt += `\n\nОбоснуй свой выбор и объясни, почему другие варианты не подходят.`;
    return prompt;
}

    // Отправляем запрос к ChatGPT
    function askChatGPT(prompt, callback) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: config.baseUrl + 'chat/completions',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`
            },
            data: JSON.stringify({
                model: config.model,
                messages: [{role: 'user', content: prompt}],
                temperature: config.temperature
            }),
            onload: function(response) {
                const data = JSON.parse(response.responseText);
                callback(null, data.choices[0].message.content);
            },
            onerror: function(error) {
                callback(error, null);
            }
        });
    }

    // Функция для извлечения данных вопроса

    // Отображаем модальное окно с ответом ChatGPT
    function showChatGPTResponse(response) {
        const modalId = 'lms-chatgpt-response-modal';
        const existingModal = document.getElementById(modalId);
        if (existingModal) existingModal.remove();

        const modalHtml = `
            <div id="${modalId}" style="
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                width: 80%;
                max-width: 800px;
                max-height: 80vh;
                background: white;
                z-index: 9999;
                padding: 20px;
                border-radius: 5px;
                box-shadow: 0 0 20px rgba(0,0,0,0.3);
                overflow: auto;
                font-family: Arial, sans-serif;
            ">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                    <h3 style="margin: 0;">Ответ ChatGPT</h3>
                    <button id="close-modal" style="
                        background: #f44336;
                        color: white;
                        border: none;
                        padding: 5px 10px;
                        border-radius: 3px;
                        cursor: pointer;
                    ">Закрыть</button>
                </div>
                <div id="chatgpt-response-content" style="
                    padding: 15px;
                    border-radius: 3px;
                    max-height: 60vh;
                    overflow: auto;
                "></div>
                <div style="margin-top: 15px; font-size: 12px; color: #666;">
                    Ответ сгенерирован ChatGPT и может содержать ошибки. Проверяйте информацию.
                </div>
            </div>
            <div id="modal-overlay" style="
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.5);
                z-index: 9998;
            "></div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHtml);

        // Рендерим markdown-ответ
        document.getElementById('chatgpt-response-content').innerHTML = marked.parse(response);

        // Обработчики событий
        document.getElementById('close-modal').addEventListener('click', () => {
            document.getElementById(modalId).remove();
            document.getElementById('modal-overlay').remove();
        });

        document.getElementById('modal-overlay').addEventListener('click', () => {
            document.getElementById(modalId).remove();
            document.getElementById('modal-overlay').remove();
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
                <p style="margin-top: 15px;">Отправляем вопрос в ChatGPT...</p>
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
        button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 5px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg> Спросить ChatGPT';

        Object.assign(button.style, {
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            zIndex: '999',
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

                showChatGPTResponse(response);
            });
        });

        document.body.appendChild(button);
    }

    // Инициализация
    function init() {
        if (isQuizAttemptPage()) {
            setTimeout(addChatGPTButton, 500);
        }
    }

    // Запускаем после загрузки страницы
    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init);
    }
})();
