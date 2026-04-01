ARG PHP_VERSION=8.4
FROM php:${PHP_VERSION}-fpm

# Common PHP extensions for Laravel/Symfony apps
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev libzip-dev libicu-dev libxml2-dev unzip git curl \
    && docker-php-ext-install pdo_pgsql pgsql zip intl xml bcmath opcache \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Composer
COPY --from=composer:latest /usr/bin/composer /usr/bin/composer

# Create non-root user
RUN groupadd -g 1000 sail && useradd -u 1000 -g sail -m sail
USER sail

WORKDIR /var/www/html
