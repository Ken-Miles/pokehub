FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY src/SaveService.csproj src/
RUN dotnet restore src/SaveService.csproj
COPY src/ src/
RUN dotnet publish src/SaveService.csproj -c Release -o /app --no-restore

FROM build AS test
COPY tests/ tests/
RUN dotnet test tests/SaveService.Tests.csproj -c Release

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app .
ENV ASPNETCORE_URLS=http://+:8080
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "SaveService.dll"]
