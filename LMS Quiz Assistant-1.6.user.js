// ==UserScript==
// @name         LMS Quiz Assistant
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Отправляет вопросы теста в ChatGPT и автоматически выбирает ответы
// @author       You
// @match        https://lms.mitu.msk.ru/mod/quiz/attempt.php*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.aitunnel.ru
// @connect      lms.mitu.msk.ru
// @require      https://cdn.jsdelivr.net/npm/marked@4.0.0/marked.min.js
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Конфигурация по умолчанию
    const defaultConfig = {
        apiKey: 'sk-aitunnel-...',
        baseUrl: 'https://api.aitunnel.ru/v1/',
        model: 'gemini-2.5-flash-lite',
        temperature: 0.7,
        maxRetries: 2,
        timeout: 15000,
        useContext: true
    };

    // Загружаем конфигурацию из хранилища
    function loadConfig() {
        const savedConfig = GM_getValue('lms_assistant_config');
        console.log('Загружены настройки из хранилища:', savedConfig);
        return savedConfig ? { ...defaultConfig, ...savedConfig } : defaultConfig;
    }

    // Сохраняем конфигурацию
    function saveConfig(config) {
        console.log('Сохраняем настройки:', config);
        GM_setValue('lms_assistant_config', config);
    }

    let config = loadConfig();
    console.log('Текущий конфиг:', config);

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
    function loadContextFromPrevActivity(callback) {
        if (!config.useContext) {
            console.log('Работа с контекстом отключена в настройках');
            callback(null);
            return;
        }

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

                    // Ищем основной контент страницы
                    const content = doc.querySelector('#region-main .activity-inner, .content, .no-overflow, [role="main"]') ||
                                   doc.querySelector('body');

                    let contextText = '';
                    if (content) {
                        // Извлекаем текстовый контент, убираем лишние пробелы
                        contextText = content.textContent
                            .replace(/\s+/g, ' ')
                            .trim()
                            .substring(0, 10000); // Ограничиваем длину для избежания переполнения
                    }

                    if (contextText.length > 0) {
                        contextCache = contextText;
                        console.log('Контекст успешно загружен, длина:', contextText.length);
                        callback(contextText);
                    } else {
                        console.log('Не удалось извлечь контекст из страницы');
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
        if (context && config.useContext) {
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

                if (context && config.useContext) {
                    console.log('Запрос выполнен с использованием учебного контекста');
                } else {
                    console.log('Запрос выполнен без учебного контекста');
                }
            });
        });
    }

    // Создаем модальное окно настроек
    function createSettingsModal() {
        // Перезагружаем конфиг перед открытием модального окна
        config = loadConfig();

        const modalId = 'lms-assistant-settings-modal';
        const existingModal = document.getElementById(modalId);
        if (existingModal) {
            existingModal.style.display = 'flex';
            return;
        }

        // Проверяем, есть ли сохраненная модель в списке предустановленных
        const isModelInList = ['gemini-2.5-flash-lite', 'gpt-4.1-nano', 'deepseek-v3.2-exp'].includes(config.model);
        const selectedModel = isModelInList ? config.model : 'custom';

        const modalHtml = `
            <div id="${modalId}" style="
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.5);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 10000;
            ">
                <div style="
                    background: white;
                    padding: 20px;
                    border-radius: 10px;
                    width: 90%;
                    max-width: 500px;
                    max-height: 80vh;
                    overflow-y: auto;
                ">
                    <h3 style="margin-top: 0; margin-bottom: 20px;">Настройки LMS Assistant</h3>

                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">API Key:</label>
                        <input type="password" id="api-key-input" value="${config.apiKey}" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
                    </div>

                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">API Base URL:</label>
                        <input type="text" id="api-url-input" value="${config.baseUrl}" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
                    </div>

                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Модель:</label>
                        <select id="model-select" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
                            <option value="gemini-2.5-flash-lite" ${selectedModel === 'gemini-2.5-flash-lite' ? 'selected' : ''}>Gemini 2.5 Flash Lite ≈0.01₽ (≈0.04₽)</option>
                            <option value="gpt-4.1-nano" ${selectedModel === 'gpt-4.1-nano' ? 'selected' : ''}>GPT-4.1 nano ≈0.01₽ (≈0.01₽)</option>
                            <option value="deepseek-v3.2-exp" ${selectedModel === 'deepseek-v3.2-exp' ? 'selected' : ''}>DeepSeek-v3.2-exp ≈0.01₽ (≈0.01₽)</option>
                            <option value="custom" ${selectedModel === 'custom' ? 'selected' : ''}>Другая модель...</option>
                        </select>
                        <input type="text" id="custom-model-input" placeholder="Введите название модели" value="${!isModelInList ? config.model : ''}" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; margin-top: 5px; display: ${selectedModel === 'custom' ? 'block' : 'none'};">
                    </div>

                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Температура (0-1):</label>
                        <input type="number" id="temperature-input" value="${config.temperature}" min="0" max="1" step="0.1" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
                    </div>

                    <div style="margin-bottom: 20px;">
                        <label style="display: flex; align-items: center; cursor: pointer;">
                            <input type="checkbox" id="use-context-checkbox" ${config.useContext ? 'checked' : ''} style="margin-right: 8px;">
                            Использовать контекст из предыдущих лекций
                        </label>
                    </div>

                    <div style="display: flex; justify-content: space-between;">
                        <button id="save-settings" style="padding: 10px 20px; background: #28a745; color: white; border: none; border-radius: 5px; cursor: pointer;">Сохранить</button>
                        <button id="reset-settings" style="padding: 10px 20px; background: #ffc107; color: black; border: none; border-radius: 5px; cursor: pointer;">Сбросить</button>
                        <button id="close-settings" style="padding: 10px 20px; background: #6c757d; color: white; border: none; border-radius: 5px; cursor: pointer;">Закрыть</button>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHtml);

        // Обработчики для модального окна
        const modal = document.getElementById(modalId);
        const modelSelect = document.getElementById('model-select');
        const customModelInput = document.getElementById('custom-model-input');

        modelSelect.addEventListener('change', function() {
            customModelInput.style.display = this.value === 'custom' ? 'block' : 'none';
            if (this.value !== 'custom') {
                customModelInput.value = '';
            }
        });

        document.getElementById('save-settings').addEventListener('click', function() {
            const newConfig = {
                apiKey: document.getElementById('api-key-input').value,
                baseUrl: document.getElementById('api-url-input').value,
                model: modelSelect.value === 'custom' ? customModelInput.value : modelSelect.value,
                temperature: parseFloat(document.getElementById('temperature-input').value),
                useContext: document.getElementById('use-context-checkbox').checked,
                maxRetries: config.maxRetries,
                timeout: config.timeout
            };

            // Проверяем корректность температуры
            if (isNaN(newConfig.temperature) || newConfig.temperature < 0 || newConfig.temperature > 1) {
                alert('Температура должна быть числом от 0 до 1');
                return;
            }

            config = newConfig;
            saveConfig(newConfig);
            modal.style.display = 'none';
            alert('Настройки сохранены!');
        });

        document.getElementById('reset-settings').addEventListener('click', function() {
            if (confirm('Сбросить настройки к значениям по умолчанию?')) {
                config = { ...defaultConfig };
                saveConfig(defaultConfig);
                modal.style.display = 'none';
                alert('Настройки сброшены!');
                // Перезагружаем страницу для применения настроек по умолчанию
                setTimeout(() => location.reload(), 1000);
            }
        });

        document.getElementById('close-settings').addEventListener('click', function() {
            modal.style.display = 'none';
        });

        modal.addEventListener('click', function(e) {
            if (e.target === modal) {
                modal.style.display = 'none';
            }
        });
    }

    // Добавляем кнопки для запроса к ChatGPT, yandex поиска и настроек
    function addControlButtons() {
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

        // Кнопка настроек
        const settingsButton = document.createElement('button');
        settingsButton.innerHTML = `
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13.1191 5.61336C13.0508 5.11856 12.6279 4.75 12.1285 4.75H11.8715C11.3721 4.75 10.9492 5.11856 10.8809 5.61336L10.7938 6.24511C10.7382 6.64815 10.4403 6.96897 10.0622 7.11922C10.006 7.14156 9.95021 7.16484 9.89497 7.18905C9.52217 7.3524 9.08438 7.3384 8.75876 7.09419L8.45119 6.86351C8.05307 6.56492 7.49597 6.60451 7.14408 6.9564L6.95641 7.14408C6.60452 7.49597 6.56492 8.05306 6.86351 8.45118L7.09419 8.75876C7.33841 9.08437 7.3524 9.52216 7.18905 9.89497C7.16484 9.95021 7.14156 10.006 7.11922 10.0622C6.96897 10.4403 6.64815 10.7382 6.24511 10.7938L5.61336 10.8809C5.11856 10.9492 4.75 11.372 4.75 11.8715V12.1285C4.75 12.6279 5.11856 13.0508 5.61336 13.1191L6.24511 13.2062C6.64815 13.2618 6.96897 13.5597 7.11922 13.9378C7.14156 13.994 7.16484 14.0498 7.18905 14.105C7.3524 14.4778 7.3384 14.9156 7.09419 15.2412L6.86351 15.5488C6.56492 15.9469 6.60451 16.504 6.9564 16.8559L7.14408 17.0436C7.49597 17.3955 8.05306 17.4351 8.45118 17.1365L8.75876 16.9058C9.08437 16.6616 9.52216 16.6476 9.89496 16.811C9.95021 16.8352 10.006 16.8584 10.0622 16.8808C10.4403 17.031 10.7382 17.3519 10.7938 17.7549L10.8809 18.3866C10.9492 18.8814 11.3721 19.25 11.8715 19.25H12.1285C12.6279 19.25 13.0508 18.8814 13.1191 18.3866L13.2062 17.7549C13.2618 17.3519 13.5597 17.031 13.9378 16.8808C13.994 16.8584 14.0498 16.8352 14.105 16.8109C14.4778 16.6476 14.9156 16.6616 15.2412 16.9058L15.5488 17.1365C15.9469 17.4351 16.504 17.3955 16.8559 17.0436L17.0436 16.8559C17.3955 16.504 17.4351 15.9469 17.1365 15.5488L16.9058 15.2412C16.6616 14.9156 16.6476 14.4778 16.811 14.105C16.8352 14.0498 16.8584 13.994 16.8808 13.9378C17.031 13.5597 17.3519 13.2618 17.7549 13.2062L18.3866 13.1191C18.8814 13.0508 19.25 12.6279 19.25 12.1285V11.8715C19.25 11.3721 18.8814 10.9492 18.3866 10.8809L17.7549 10.7938C17.3519 10.7382 17.031 10.4403 16.8808 10.0622C16.8584 10.006 16.8352 9.95021 16.8109 9.89496C16.6476 9.52216 16.6616 9.08437 16.9058 8.75875L17.1365 8.4512C17.4351 8.05308 17.3955 7.49599 17.0436 7.1441L16.8559 6.95642C16.504 6.60453 15.9469 6.56494 15.5488 6.86353L15.2412 7.09419C14.9156 7.33841 14.4778 7.3524 14.105 7.18905C14.0498 7.16484 13.994 7.14156 13.9378 7.11922C13.5597 6.96897 13.2618 6.64815 13.2062 6.24511L13.1191 5.61336Z"></path>
                <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13.25 12C13.25 12.6904 12.6904 13.25 12 13.25C11.3096 13.25 10.75 12.6904 10.75 12C10.75 11.3096 11.3096 10.75 12 10.75C12.6904 10.75 13.25 11.3096 13.25 12Z"></path>
            </svg>
        `;

        Object.assign(settingsButton.style, {
            width: '50px',
            height: '50px',
            padding: '0',
            backgroundColor: '#6c757d',
            border: 'none',
            borderRadius: '5px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
        });

        const settingsSvg = settingsButton.querySelector('svg');
        settingsSvg.style.cssText = `
            display: block;
            margin: auto;
            color: white;
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
            padding: '13px 15px',
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
        settingsButton.addEventListener('click', createSettingsModal);

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
        container.appendChild(settingsButton);
        container.appendChild(yandexButton);
        container.appendChild(chatGPTButton);
        document.body.appendChild(container);
    }

    // Инициализация
    function init() {
        if (isQuizAttemptPage()) {
            setTimeout(addControlButtons, 100);
        }
    }

    // Запускаем после загрузки страницы
    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init);
    }
})();
